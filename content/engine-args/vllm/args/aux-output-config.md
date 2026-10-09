---
schema: 1
engine: vllm
primaryName: "--aux-output-config"
title: "--aux-output-config"
summary: JSON-конфиг `AuxOutputConfig` — вспомогательные выходы исполнения, сегодня это только маршрутизация экспертов MoE (`enable_return_routed_experts`) и емкость хостового хранилища для нее (`max_bytes`). Нужен RL-пайплайнам на MoE-моделях; на обычном инференс-инстансе не задается.
group: VllmConfig
related:
  - --enable-return-routed-experts
  - --enable-prefix-caching
  - --kv-transfer-config
  - --pipeline-parallel-size
  - --decode-context-parallel-size
  - --prefill-context-parallel-size
  - --speculative-config
  - --max-num-batched-tokens
---

# --aux-output-config

## Кратко

Контейнер для «вспомогательных выходов» — данных, которые снимаются во время forward и возвращаются клиенту вместе с токенами. В этом commit'е такой выход один: какие эксперты MoE выбрал роутер для каждого токена на каждом слое (routed experts). Флаг `--enable-return-routed-experts` теперь лишь короткий способ включить поле `enable_return_routed_experts` этого конфига.

Второе поле, `max_bytes`, задает емкость хостового LRU-хранилища маршрутизации. Маршрутизация хранится поблочно, ключом служит хеш KV-блока, поэтому механизм требует prefix caching: при попадании в префикс маршрутизация закэшированных токенов достается из этого хранилища по хешам блоков.

## Оригинальная справка

```text
Execution auxiliary output configuration.
```

## Паспорт аргумента

- Флаги: `--aux-output-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект `AuxOutputConfig`
- Допустимые значения: ключи `enable_return_routed_experts` (bool, по умолчанию `false`) и `max_bytes` (int `> 0` или `null`, по умолчанию `null`); других полей у датакласса нет
- Значение по умолчанию: `Field(default_factory=AuxOutputConfig)` — объект с `enable_return_routed_experts=false`, `max_bytes=null`, то есть все выключено
- Эффективное значение: `EngineArgs.__post_init__` выставляет `aux_output_config.enable_return_routed_experts = True`, если задан `--enable-return-routed-experts`. Обратного действия нет: `--no-enable-return-routed-experts` не выключает поле, включенное через JSON. `max_bytes=null` превращается в емкость, вычисленную по размеру KV-cache (см. ниже)
- Где объявлен: `vllm/config/vllm.py:VllmConfig.aux_output_config`
- Этап применения: сборка `VllmConfig` (`_verify_aux_output_compatibility`) → инициализация планировщика (`AuxOutputSchedulerConnector`) → инициализация KV-cache в model runner V2 (`AuxOutputWorkerConnector`, хуки на MoE-слоях) → каждый шаг → формирование ответа

## Что меняет в движке

**Проверки при сборке конфига.** Если вспомогательный выход включен, `VllmConfig._verify_aux_output_compatibility()` отвергает старт с `ValueError`, когда:

- используется model runner V1 на in-tree платформе: `AuxOutput Connector requires Model Runner V2; set VLLM_USE_V2_MODEL_RUNNER=1.` (TPU и out-of-tree платформы проверяют поддержку сами);
- runner не `generate`: `AuxOutput Connector only supports generate runners.`;
- модель не MoE: `AuxOutput Connector only supports MoE models.`;
- prefix caching выключен: `AuxOutput Connector requires prefix caching.`;
- включена adaptive speculative verification, `pipeline_parallel_size > 1` или decode/prefill context parallel `> 1`;
- в `--kv-transfer-config` есть `NixlConnector`, `NixlPullConnector`, `NixlPushConnector`, `MoRIIOConnector` или `MooncakeConnector`: `--enable-return-routed-experts is incompatible with <имя>; PD auxiliary output is not supported.` Коннекторы offload/sharing (`OffloadingConnector`, `LMCacheConnectorV1`, `LMCacheMPConnector`, `MooncakeStoreConnector`, `SimpleCPUOffloadConnector`) по тестам апстрима допускаются.

`AuxOutputConfig.compute_hash()` учитывает `enable_return_routed_experts`, потому что включение меняет forward-граф: включение и выключение инвалидирует кэш компиляции. `max_bytes` в хеш не входит.

**Планировщик.** `AuxOutputSchedulerConnector` на каждом шаге отправляет worker'у новые хеши KV-блоков запросов и события завершения. Сами данные маршрутизации планировщик не хранит.

**Worker.** `AuxOutputWorkerConnector` создается в model runner V2 после инициализации KV-cache:

- `RoutedExpertsCapturer` вешает хуки на MoE-слои и держит device-буфер `max_num_batched_tokens × num_layers × num_experts_per_tok` в `int32`;
- на хосте элемент маршрутизации — `uint8`, если экспертов не больше 256, иначе `uint16`;
- хранилище и буферы данных создаются только на первом TP-ранге (output rank), остальные ранги участвуют только в захвате.

**Хранилище (`max_bytes`).** `BlockObjectStore` — анонимный `mmap` на хосте, нарезанный на слоты по одному hash-блоку маршрутизации (`hash_block_size × num_layers × top_k × размер элемента`). Если `max_bytes` не задан, емкость равна `num_blocks × (scheduler_block_size / hash_block_size) × block_nbytes`, то есть маршрутизация для каждого токена, который помещается в KV-cache. Вытеснение LRU пропускает объекты, на которые еще ссылаются активные запросы.

**Ответ.** Маршрутизация собирается из хранилища по ключам блоков и возвращается в поле `routed_experts` (base64 от numpy-массива) в ответах chat completions, completions и token-in-token-out API. Per-request параметр `routed_experts_prompt_start` позволяет не возвращать первые N токенов промпта.

## Значения и формат

Одной строкой:

```text
--aux-output-config '{"enable_return_routed_experts": true, "max_bytes": 8589934592}'
```

Точечными под-флагами:

```text
--aux-output-config.enable_return_routed_experts true --aux-output-config.max_bytes 8589934592
```

- `max_bytes` — байты, без суффиксов. `0` и отрицательные значения отвергает валидация `gt=0`; значение меньше одного объекта дает `ValueError: auxiliary output store must fit at least one object` при инициализации worker'а.
- `max_bytes: null` (по умолчанию) — емкость по размеру KV-cache.
- `{}` или флаг не задан — вспомогательные выходы выключены, хуки не ставятся, проверки совместимости не выполняются.

## Когда использовать

- RL-пайплайн на MoE-модели, которому нужна маршрутизация для расчета наград или контроля стабильности роутера. Для простого включения хватает `--enable-return-routed-experts`; JSON нужен, когда надо ограничить или увеличить `max_bytes`.
- `max_bytes` ниже автоматического значения задают, когда хостовой RAM мало, а KV-cache большой. Цена — ошибка на запросе, которому при попадании в префикс понадобится уже вытесненный блок маршрутизации.
- Не включайте на обычном инференс-инстансе: это требует MRV2 и prefix caching, запрещает PP, context parallel и PD-коннекторы, добавляет D2H-копию на каждом шаге и тратит хостовую RAM.

## Влияние на производительность и память

- **Хостовая RAM.** Хранилище по умолчанию рассчитано на весь KV-cache: `токены KV-cache × num_layers × top_k × 1 (или 2) байта`. Для 1 млн токенов KV-cache, 60 MoE-слоев и `top_k = 8` это около 480 МБ. Это анонимный `mmap`: адресное пространство резервируется сразу, физические страницы занимаются по мере записи.
- **VRAM.** Device-буфер захвата `max_num_batched_tokens × num_layers × top_k × 4` байта; при бюджете 8192 токенов, 60 слоях и `top_k = 8` это около 15 МБ.
- **Throughput.** Каждый шаг копирует маршрутизацию на хост и публикует блоки в фоновом потоке `vllm-aux-output-writer`.
- **Время старта.** Включение меняет хеш компиляции, первый старт после переключения компилирует граф заново.

## Взаимодействие с другими аргументами

- `--enable-return-routed-experts`: короткая форма для `{"enable_return_routed_experts": true}`, умеет только включать.
- `--enable-prefix-caching`: обязателен; маршрутизация адресуется хешами KV-блоков.
- `--kv-transfer-config`: PD-коннекторы (`Nixl*`, `MoRIIOConnector`, `MooncakeConnector`) несовместимы, коннекторы offload/sharing допускаются.
- `--pipeline-parallel-size`, `--decode-context-parallel-size`, `--prefill-context-parallel-size`: значения больше 1 несовместимы.
- `--speculative-config`: adaptive verification несовместима; обычная спекулятивная генерация допускается.
- `--max-num-batched-tokens`: задает размер device-буфера захвата и хостового буфера незавершенных блоков.

## Типовые проблемы и диагностика

- **Симптом:** `AuxOutput Connector requires Model Runner V2; set VLLM_USE_V2_MODEL_RUNNER=1.` **Причина:** движок выбрал V1 runner (переменная `VLLM_USE_V2_MODEL_RUNNER=0`, неподдерживаемая V2 функция или дефолт ROCm для части архитектур). **Лечение:** снять несовместимость или явно включить V2.
- **Симптом:** `AuxOutput Connector requires prefix caching.` **Лечение:** убрать `--no-enable-prefix-caching`.
- **Симптом:** `AuxOutput Connector only supports MoE models.` **Причина:** плотная модель. **Лечение:** выключить вспомогательные выходы.
- **Симптом:** `auxiliary output object does not exist; the object may have been evicted (used=..., limit=... objects). Increase aux_output_config.max_bytes when a KV cache hit requires it.` **Причина:** `max_bytes` меньше, чем нужно для блоков, оставшихся в prefix cache. Коннектор исключение не перехватывает, это отказ обработки, а не пустое поле в ответе. **Лечение:** поднять `max_bytes` или вернуть `null`.
- **Симптом:** `auxiliary output store cannot retain the requested batch: limit=N objects`. **Причина:** все слоты заняты блоками активных запросов. **Лечение:** поднять `max_bytes`.
- **Подтверждение принятого значения:** при инициализации worker'а `RoutedExpertsCapturer: allocating buffer with max_tokens=..., num_layers=..., num_experts_per_tok=...`; строка `Initializing a V1 LLM engine (v...) with config: ...` содержит `aux_output_config=AuxOutputConfig(...)` с итоговыми значениями.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --aux-output-config '{"enable_return_routed_experts": true}'
```

```bash
vllm serve /models/Qwen3-30B-A3B --aux-output-config.enable_return_routed_experts true --aux-output-config.max_bytes 4294967296 --enable-prefix-caching
```

## Источники

- `vllm/vllm/config/aux_output.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/distributed/aux_output_connector/connector.py`
- `vllm/vllm/distributed/aux_output_connector/worker.py`
- `vllm/vllm/distributed/aux_output_connector/store.py`
- `vllm/vllm/distributed/aux_output_connector/routed_experts.py`
- `vllm/vllm/model_executor/layers/fused_moe/routed_experts_capturer.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/tests/config/test_aux_output_config.py`
