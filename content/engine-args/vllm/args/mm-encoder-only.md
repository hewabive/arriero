---
schema: 1
engine: vllm
primaryName: "--mm-encoder-only"
title: "--mm-encoder-only"
summary: Инстанс поднимает только энкодер: веса языковой модели не инициализируются, sampler и pooler не прогоняются. Осмысленно исключительно в разнесённой encode/prefill/decode-схеме, где эмбеддинги уходят потребителю через EC-коннектор.
group: MultiModalConfig
related:
  - --ec-transfer-config
  - --enable-mm-embeds
  - --limit-mm-per-prompt
  - --mm-encoder-tp-mode
  - --mm-tensor-ipc
  - --gpu-memory-utilization
  - --max-num-batched-tokens
---

# --mm-encoder-only

## Кратко

Зеркальная половина `--enable-mm-embeds`: там инстанс принимает готовые эмбеддинги и не держит энкодер, здесь — держит только энкодер и не держит языковую модель.

Флаг сам по себе роли в EPD-развёртке не задаёт: роль задаёт `--ec-transfer-config` (`ec_role`). `--mm-encoder-only` — оптимизация поверх этой роли, и апстрим-пример помечает его как необязательный: «If possible, skips the language model during initialization to reduce device memory usage».

Парный флаг — `--no-mm-encoder-only`.

## Оригинальная справка

```text
When enabled, skips the language component of the model.

This is usually only valid in disaggregated Encoder process.
```

## Паспорт аргумента

- Флаги: `--mm-encoder-only`, `--no-mm-encoder-only`
- Группа argparse: `MultiModalConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: `True` / `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется, но участвует в производном `VllmConfig.is_encoder_only` вместе с EC-ролью: `is_encoder_only = is_ec_producer_only or mm_encoder_only`
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_encoder_only`
- Этап применения: загрузка модели (пропуск языковых модулей) → профилирование → выделение KV-cache → планировщик

## Что меняет в движке

**Пропуск весов.** `SupportsMultiModal._mark_language_model` оборачивает инициализацию языковых потомков в `no_init_weights`, если `mm_config.mm_encoder_only`. Модули заменяются на `StageMissingLayer("language_model", ...)`, веса не читаются и VRAM не занимают. Аналогичная проверка есть в transformers-backend (`vllm/model_executor/models/transformers/multimodal.py`).

**Профилировочные прогоны.** В `GPUModelRunner` три места коротко замыкаются на пустой тензор при включённом флаге: `_dummy_run` (комментарий прямо говорит, что текущий dummy run покрывает только LM), `_dummy_sampler_run` и `_dummy_pooler_run`. То есть языковая часть не профилируется, потому что её нет.

**KV-cache.** В новом раннере (`vllm/v1/worker/gpu/model_runner.py`) `get_kv_cache_spec()` возвращает `{}` при `is_encoder_only`, а `_dummy_run` немедленно отдаёт пустые тензоры — KV-cache не выделяется вовсе. В унаследованном раннере (`vllm/v1/worker/gpu_model_runner.py`) решение о пустом KV-cache принимается по EC-роли (`has_ec_transfer() and not is_consumer`), а не по этому флагу; какой раннер у вас активен, определяется `VLLM_USE_V2_MODEL_RUNNER` и правилами `VllmConfig.use_v2_model_runner`.

**Планировщик.** `Scheduler.is_encoder_only` меняет условие завершения запроса: энкодерный инстанс не сэмплирует, а публикует эмбеддинги, поэтому запрос считается завершённым, как только потреблён весь промпт.

## Значения и формат

- Флага нет — `False`, обычный инстанс.
- `--mm-encoder-only` — `True`.
- `--no-mm-encoder-only` — явный `False`.
- Флаг не проверяет, что вы действительно в EPD-развёртке. Включённый на одиночном инстансе, он даст сервер, который не умеет генерировать текст: языковых весов нет.

## Когда использовать

- Энкодерный узел разнесённой схемы (`ec_role: ec_producer`), работающий в паре с prefill/decode-инстансом через EC-коннектор. Готовые сценарии — `examples/disaggregated/disaggregated_encoder/disagg_1e1pd_example.sh` и `disagg_1e1p1d_example.sh` в checkout'е.
- Когда энкодерный узел упирается в VRAM: пропуск языковых весов — самая крупная экономия, доступная на этом узле.
- Не включайте на обычном сервере: сервер перестанет отвечать осмысленно, а ошибка проявится не при старте, а на первом запросе.
- Не используйте как «режим только эмбеддингов» для pooling-моделей: за это отвечают `--runner`/`--convert`, а тут просто не инициализируется языковая часть.

## Влияние на производительность и память

- **VRAM (веса).** Основной эффект: языковая модель — обычно на порядок крупнее энкодера, и её веса просто не создаются.
- **VRAM (KV-cache).** На новом раннере не выделяется вовсе.
- **Время старта.** Заметно короче: меньше весов с диска, нет профилировочных прогонов LM, sampler и pooler.
- **Throughput.** Узел занимается только энкодером; его пропускная способность определяется `--max-num-batched-tokens` (через encoder budget) и `--mm-encoder-tp-mode`.
- **Latency.** TTFT всей связки складывается из времени энкодера здесь и prefill на потребителе; выигрыш в том, что эти этапы масштабируются независимо.

## Взаимодействие с другими аргументами

- `--ec-transfer-config`: задаёт саму роль (`ec_producer` / `ec_consumer` / `ec_both`) и коннектор. Без него флаг не образует работающую схему.
- `--enable-mm-embeds`: включается на **другой** стороне — на prefill/decode-инстансе, чтобы тот принимал эмбеддинги.
- `--limit-mm-per-prompt`: на энкодерном узле определяет размер профилировочного батча энкодера и потолок на запрос.
- `--mm-encoder-tp-mode`: единственный оставшийся рычаг параллелизма на этом узле — весь TP тратится на энкодер.
- `--mm-tensor-ipc`: на энкодерном узле, через который идёт весь мультимодальный трафик, `torch_shm` убирает сериализацию тензоров между API- и engine-процессом.
- `--gpu-memory-utilization`: продолжает ограничивать общий бюджет; на энкодерном узле его обычно можно ставить ниже, поскольку KV-cache не нужен.
- `--max-num-batched-tokens`: задаёт `encoder_compute_budget` и `encoder_cache_size`, то есть реальную ёмкость энкодерного узла.

## Типовые проблемы и диагностика

- **Симптом:** сервер поднялся, но обычный `/v1/chat/completions` возвращает мусор или падает. **Причина:** языковой части нет. **Лечение:** флаг применим только к энкодерному узлу EPD-схемы.
- **Симптом:** VRAM не уменьшилась. **Причина:** архитектура не помечает языковые модули как `language_model`-компоненты (`_mark_language_model` не вызван). **Проверка:** сверьте класс модели в `vllm/model_executor/models/`; для transformers-backend поддержка есть.
- **Симптом:** KV-cache всё равно выделяется. **Причина:** активен унаследованный раннер, где это решение принимается по EC-роли. **Лечение:** задать корректный `ec_role: ec_producer` в `--ec-transfer-config`.
- **Симптом:** эмбеддинги не доходят до второго инстанса. **Причина:** проблема EC-коннектора, а не этого флага. **Проверка:** `ec_connector`, `ec_role` и `ec_connector_extra_config` на обеих сторонах; тесты в `tests/v1/ec_connector`.
- **Подтверждение принятого значения:** отсутствие в логе строк профилирования сэмплера/пулера и малый объём загруженных весов; значение видно в стартовой строке конфига как `mm_encoder_only=True`.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-encoder-only --enforce-eager --max-num-batched-tokens 114688 --ec-transfer-config '{"ec_connector": "ECExampleConnector", "ec_role": "ec_producer", "ec_connector_extra_config": {"shared_storage_path": "/tmp/ec-cache"}}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --enable-mm-embeds --limit-mm-per-prompt '{"image": 0}' --ec-transfer-config '{"ec_connector": "ECExampleConnector", "ec_role": "ec_consumer", "ec_connector_extra_config": {"shared_storage_path": "/tmp/ec-cache"}}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/ec_transfer.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu/model_runner.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/docs/features/disagg_encoder.md`
- `vllm/examples/disaggregated/disaggregated_encoder/README.md`
