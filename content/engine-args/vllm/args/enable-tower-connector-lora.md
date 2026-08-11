---
schema: 1
engine: vllm
primaryName: "--enable-tower-connector-lora"
title: "--enable-tower-connector-lora"
summary: Экспериментальное расширение LoRA на визуальный энкодер и коннектор мультимодальной модели. Добавляет отдельные punica-обёртки под энкодерные токены и делает кэш мультимодальных эмбеддингов зависимым от имени адаптера.
group: LoRAConfig
related:
  - --enable-lora
  - --max-loras
  - --max-lora-rank
  - --max-num-seqs
  - --limit-mm-per-prompt
  - --default-mm-loras
  - --lora-target-modules
---

# --enable-tower-connector-lora

## Кратко

Без этого флага LoRA применяется только к языковой части мультимодальной модели: энкодер (tower) и коннектор остаются базовыми. Флаг разрешает оборачивать и их — при условии, что модель реализует вспомогательные функции подсчёта токенов.

Функция помечена в собственной справке как экспериментальная, и движок при её включении печатает предупреждение. Второе следствие, о котором легко забыть: ключ кэша мультимодальных эмбеддингов начинает включать имя адаптера, потому что эмбеддинги теперь зависят от LoRA.

## Оригинальная справка

```text
If `True`, LoRA support for the tower (vision encoder) and connector 
of multimodal models will be enabled. This is an experimental feature and 
currently only supports some MM models such as the Qwen VL series. The default 
is False.
```

## Паспорт аргумента

- Флаги: `--enable-tower-connector-lora`, `--no-enable-tower-connector-lora`
- Группа argparse: `LoRAConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: движок сбрасывает поддержку в трёх случаях — модель не мультимодальная или не реализует `get_num_mm_encoder_tokens()` (предупреждение `LoRA with tower connector is enabled, but the model %s does not support it. This will be ignored.`), либо мультимодальная конфигурация запущена в режиме `language_model_only` (предупреждение `Disabling 'enable_tower_connector_lora' because the multimodal model is configured to initialize the language model only.`). Обратный случай тоже логируется: если модель умеет, но флаг выключен, в логе появляется `%s supports adding LoRA to the tower modules. If needed, please set 'enable_tower_connector_lora=True'.`
- Где объявлен: `vllm/config/lora.py:LoRAConfig.enable_tower_connector_lora`
- Этап применения: загрузка модели (создание дополнительных punica-обёрток и обёртывание модулей энкодера/коннектора) → входной слой (ключ кэша mm-эмбеддингов) → forward

## Что меняет в движке

**Дополнительные punica-обёртки.** По умолчанию `LoRAModelManager._maybe_init_mm()` создаёт одну обёртку под языковую модель, рассчитанную на `max_num_batched_tokens` токенов и `max_num_seqs` батчей. С флагом добавляются ещё две:

- tower: `get_punica_wrapper(num_encoder_tokens, max_batches=max_num_seqs × limit_per_prompt, …)`, где `num_encoder_tokens` — `model.get_num_mm_encoder_tokens(mm_budget.get_encoder_budget())`, а `limit_per_prompt` — максимум по `--limit-mm-per-prompt`;
- connector: только если модель реализует `get_num_mm_connector_tokens()`; иначе печатается `Connector LoRA support disabled: model does not implement get_num_mm_connector_tokens(). This method is required to determine the connector's token budget for LoRA operations.` и коннектор остаётся без LoRA.

Каждая обёртка выделяет собственные метаданные ядра `LoRAKernelMeta` размером под свой бюджет токенов.

**Маршрутизация модулей.** `_get_punica_wrapper(module_name)` подбирает обёртку по самому длинному совпавшему префиксу из `MultiModelKeys` модели, поэтому модули энкодера и коннектора попадают в свои обёртки, а не в языковую. Модуль, для которого обёртка не нашлась, пропускается с предупреждением `Regarding %s, no matching PunicaWrapper is found; %s will be ignored.`

**Отдельные forward-проходы.** `set_active_loras(..., mapping_type=LoRAMappingType.TOWER)` и `...CONNECTOR` выставляют маппинг адаптеров перед прогоном энкодера и коннектора, отдельно от языкового прохода.

**Кэш мультимодальных эмбеддингов.** `InputProcessor._get_mm_identifier()` при включённом флаге превращает `mm_hash` в `"<имя адаптера>:<mm_hash>"`. Без этого запросы с разными адаптерами получали бы один и тот же кэшированный эмбеддинг картинки — то есть неверный результат. Побочный эффект: кэш эмбеддингов больше не переиспользуется между адаптерами, и хит-рейт падает пропорционально числу активных адаптеров.

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-enable-tower-connector-lora` эквивалентны.
- Никаких значений флаг не принимает.
- Значение входит в `LoRAConfig.compute_hash()`, поэтому переключение инвалидирует кэш компиляции.
- Поддержка со стороны модели — не список в коде, а наличие методов `get_num_mm_encoder_tokens()` (обязательно) и `get_num_mm_connector_tokens()` (для коннектора). Справка называет ориентиром серию Qwen VL; актуальный статус моделей ведётся в upstream-issue, указанном в `vllm/docs/features/lora.md`.

## Когда использовать

- Адаптер обучен с LoRA на визуальном энкодере или коннекторе, и без этого флага его веса на эти модули просто не применяются.
- Не включайте, если адаптер трогает только языковую часть: получите лишние буферы, лишние проходы и испорченный кэш mm-эмбеддингов без выигрыша.
- Экспериментальный статус означает, что контракт может измениться между релизами; фиксируйте версию vLLM и проверяйте наличие флага через `vllm serve --help` установленного окружения.

## Влияние на производительность и память

- **VRAM.** Добавляются LoRA-буферы для модулей энкодера и коннектора (по тем же формулам `max_loras × max_lora_rank × размерности`) плюс метаданные двух дополнительных punica-обёрток, размер которых задаётся энкодерным бюджетом токенов и `max_num_seqs × limit_per_prompt`.
- **RAM хоста.** Косвенно: адаптеры содержат больше модулей, значит их CPU-копии крупнее.
- **Время старта.** Растёт: больше подменяемых модулей и больше выделяемых буферов.
- **Throughput.** Энкодерный проход получает LoRA-ядра, то есть дорожает. Отдельно бьёт по кэшу мультимодальных эмбеддингов: одна и та же картинка, пришедшая с двумя разными адаптерами, обрабатывается дважды.

## Взаимодействие с другими аргументами

- `--enable-lora`: обязателен.
- `--max-loras`, `--max-lora-rank`, `--lora-dtype`: те же множители, теперь применённые к большему числу модулей.
- `--max-num-seqs` и `--limit-mm-per-prompt`: произведение задаёт `max_batches` для tower/connector обёрток, то есть размер их метаданных.
- `--lora-target-modules`: фильтр применяется и к модулям энкодера/коннектора.
- `--default-mm-loras`: удобный спутник — автоподстановка адаптера по модальности; на сам механизм tower/connector не влияет.

## Типовые проблемы и диагностика

- **Симптом:** в логе `LoRA with tower connector is enabled, but the model <Class> does not support it. This will be ignored.` **Причина:** модель не реализует `get_num_mm_encoder_tokens()`. **Лечение:** флаг для этой модели бесполезен, убрать.
- **Симптом:** `Connector LoRA support disabled: model does not implement get_num_mm_connector_tokens()...`. **Причина:** энкодер обёрнут, коннектор — нет. **Лечение:** ожидаемое поведение для частично поддержанных моделей.
- **Симптом:** `Disabling 'enable_tower_connector_lora' because the multimodal model is configured to initialize the language model only.` **Причина:** модель инициализируется только как языковая. **Лечение:** флаг несовместим с этим режимом.
- **Симптом:** `Regarding <Class>, no matching PunicaWrapper is found; <module> will be ignored.` **Причина:** имя модуля не попало ни под один префикс `MultiModelKeys`. **Лечение:** без правки модели ничего не сделать; модуль останется без LoRA.
- **Симптом:** после включения флага резко упал хит-рейт кэша мультимодальных эмбеддингов. **Причина:** ключ кэша теперь включает имя адаптера. **Проверка:** метрики mm-кэша в `/metrics`. **Лечение:** ожидаемое поведение; уменьшить число одновременно используемых адаптеров.
- **Подтверждение принятого значения:** предупреждение `LoRA for the tower and connector of multimodal models is experimental and may contain bugs.` в логе старта — оно печатается только когда функция реально включилась.

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B --enable-lora --enable-tower-connector-lora --max-lora-rank 32 --limit-mm-per-prompt '{"image": 2}'
```

```bash
vllm serve /models/Qwen3-VL-8B --enable-lora --enable-tower-connector-lora --max-loras 2 --max-num-seqs 4 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/vllm/v1/engine/input_processor.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu/mm/lora.py`
- `vllm/vllm/multimodal/encoder_budget.py`
- `vllm/docs/features/lora.md`
