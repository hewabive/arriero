---
schema: 1
engine: vllm
primaryName: "--enable-lora"
title: "--enable-lora"
summary: Главный выключатель LoRA-подсистемы: без него `LoRAConfig` не создаётся и все остальные `--*-lora*` аргументы не имеют эффекта. Включение меняет граф модели, отнимает VRAM на старте и добавляет ограничение планировщику.
group: LoRAConfig
related:
  - --lora-modules
  - --max-loras
  - --max-lora-rank
  - --max-cpu-loras
  - --lora-dtype
  - --lora-target-modules
  - --fully-sharded-loras
  - --default-mm-loras
  - --gpu-memory-utilization
---

# --enable-lora

## Кратко

Единственный флаг группы `LoRAConfig`, который решает, будет ли объект `LoRAConfig` вообще построен. Если он не задан, `create_engine_config()` подставляет `lora_config=None`, и все остальные LoRA-аргументы молча остаются мёртвыми значениями в `EngineArgs`.

Включение — не бесплатная опция «на будущее»: линейные слои модели подменяются LoRA-обёртками, буферы адаптеров выделяются на GPU до профилирования памяти, профилирование выполняется с фиктивными адаптерами, а планировщик получает жёсткое ограничение «не более `--max-loras` разных адаптеров в одном шаге».

## Оригинальная справка

```text
If True, enable handling of LoRA adapters.
```

## Паспорт аргумента

- Флаги: `--enable-lora`, `--no-enable-lora`
- Группа argparse: `LoRAConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; парный `--no-enable-lora` выключает явно
- Значение по умолчанию: в extract `null`. Аргумент добавлен в `add_cli_args` вручную, без `default=`, поэтому argparse кладёт в namespace `None`, и `EngineArgs.enable_lora` получает `None`, а не объявленный в датаклассе `False`
- Эффективное значение: `None` и `False` неразличимы — в `create_engine_config()` стоит `if self.enable_lora`, то есть оба варианта дают `lora_config=None`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args` (единственный аргумент группы, объявленный не через поле датакласса `LoRAConfig`)
- Этап применения: сборка `VllmConfig` (`create_engine_config`) → загрузка модели (подмена слоёв) → профилирование памяти → планировщик → HTTP-слой

## Что меняет в движке

`create_engine_config()` строит `LoRAConfig(max_lora_rank=…, max_loras=…, default_mm_loras=…, fully_sharded_loras=…, lora_dtype=…, target_modules=…, enable_tower_connector_lora=…, specialize_active_lora=…, enable_mixed_moe_lora_format=…, enable_moe_shared_loras=…, max_cpu_loras=…)` только под условием `if self.enable_lora`. Дальше наличие `vllm_config.lora_config` включает четыре независимых механизма:

1. **Граф модели.** `LoRAModelRunnerMixin.load_lora_model()` требует, чтобы класс модели реализовывал `SupportsLoRA` (иначе `ValueError: <Class> does not support LoRA yet.`), создаёт `LRUCacheWorkerLoRAManager` и вызывает `_create_lora_modules()`, который проходит по `named_modules()` и заменяет каждый поддерживаемый линейный слой на соответствующую LoRA-обёртку. У каждой обёртки сразу выделяются постоянные GPU-буферы `lora_a_stacked`/`lora_b_stacked` — их размер задают `--max-loras`, `--max-lora-rank` и `--lora-dtype`.
2. **Профилирование памяти.** Прогон профилирования оборачивается в `maybe_setup_dummy_loras()`: создаётся ровно `max_loras` фиктивных адаптеров ранга `min(max_lora_rank, 8)`, чтобы пик активаций измерялся с LoRA-ядрами. Именно поэтому включение LoRA уменьшает остаток под KV-cache при том же `--gpu-memory-utilization`.
3. **Планировщик.** `Scheduler.schedule()` собирает множество `scheduled_loras` и отказывается брать из очереди запрос с новым адаптером, если в шаге уже занято `max_loras` разных адаптеров; такой запрос откладывается до следующего шага.
4. **HTTP-слой.** `InputProcessor._validate_lora()` отклоняет любой запрос с `lora_request`, если `lora_config` пуст. Административные эндпоинты `POST /v1/load_lora_adapter` и `/v1/unload_lora_adapter` дополнительно требуют `VLLM_ALLOW_RUNTIME_LORA_UPDATING=1` и несовместимы с `--api-server-count > 1`.

Кроме того, `LoRAConfig.compute_hash()` входит в общий хэш конфигурации компиляции: смена `max_lora_rank`, `max_loras`, `fully_sharded_loras`, `lora_dtype`, `target_modules` и MoE-флагов инвалидирует кэш компиляции и заставляет пересобрать графы.

## Значения и формат

- `--enable-lora` — включить, `--no-enable-lora` — выключить явно.
- Флаг не задан ⇒ `None`, что движок трактует как «выключено». Разницы между «не задан» и `--no-enable-lora` в поведении нет; вторая форма полезна, чтобы перебить значение, пришедшее из `--config file.yaml`.
- Аргумент не принимает значения (`--enable-lora true` будет разобрано как флаг плюс позиционный аргумент и почти наверняка сломает разбор имени модели).

## Когда использовать

- Несколько дообученных вариантов одной базовой модели надо обслуживать одним процессом: адаптеры делят веса базы, и это дешевле, чем несколько инстансов.
- Нужны административные эндпоинты подгрузки адаптеров без перезапуска (в связке с `VLLM_ALLOW_RUNTIME_LORA_UPDATING`; по `vllm/docs/usage/security.md` их нельзя открывать недоверенным клиентам).
- Не включайте «про запас»: даже без единого адаптера в наличии слои остаются обёрнутыми, буферы выделены, профилирование прошло с фиктивными адаптерами, а кэш компиляции отличается от кэша базовой модели.
- Не включайте ради одного постоянного адаптера, который всегда применяется: дешевле смержить его в веса офлайн и отдавать обычной моделью.

## Влияние на производительность и память

- **VRAM.** Постоянные буферы всех обёрнутых слоёв (порядок величины — `max_loras × max_lora_rank × (сумма входных и выходных размерностей LoRA-слоёв) × размер элемента`) плюс метаданные punica-обёртки, зависящие от `--max-num-batched-tokens` и `--max-num-seqs`. Всё это вычитается из бюджета `--gpu-memory-utilization` до расчёта KV-cache.
- **RAM хоста.** Веса зарегистрированных адаптеров хранятся на CPU (при доступном pinned memory — в закреплённой памяти), число копий ограничено `--max-cpu-loras`.
- **Время старта.** Растёт: обход модулей и подмена слоёв, выделение буферов, профилирование с фиктивными адаптерами, отдельные захваты CUDA graph для LoRA-случаев.
- **Throughput/latency.** На каждом forward добавляются shrink/expand-ядра LoRA. Батч, в котором одновременно живут несколько адаптеров, дороже однородного; при спросе выше `--max-loras` планировщик начинает откладывать запросы, и растёт время ожидания в очереди.

## Взаимодействие с другими аргументами

- `--lora-modules` (группа `Frontend`): без `--enable-lora` статическая загрузка адаптеров падает на старте. Механика самого списка описана в его документе.
- `--max-loras`, `--max-lora-rank`, `--max-cpu-loras`, `--lora-dtype`, `--lora-target-modules`, `--fully-sharded-loras`, `--default-mm-loras`: применяются только при включённом флаге, иначе игнорируются без предупреждения.
- `--gpu-memory-utilization`: бюджет один на всех; LoRA-буферы уменьшают остаток под KV-cache.
- `--max-num-seqs`, `--max-num-batched-tokens`: задают размер метаданных LoRA-ядер (`LoRAKernelMeta` выделяется на `max_num_batched_tokens` токенов) и вместе с `--max-loras` определяют, насколько дорогим получается смешанный батч.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: LoRA is not enabled. Use --enable-lora to enable LoRA.` **Причина:** попытка загрузить адаптер (статически через `--lora-modules` или запросом `POST /v1/load_lora_adapter`) при выключенной подсистеме. **Лечение:** добавить `--enable-lora`.
- **Симптом:** запрос отвергнут с `Got lora_request ... but LoRA is not enabled!`. **Причина:** та же, но на входном слое движка. **Лечение:** та же.
- **Симптом:** старт падает с `<ModelClass> does not support LoRA yet.` **Причина:** архитектура модели не реализует `SupportsLoRA`. **Проверка:** список поддерживающих LoRA моделей в `vllm/docs/models/supported_models.md`. **Лечение:** другая база или отключить LoRA.
- **Симптом:** после включения LoRA `Available KV cache memory` заметно упало и `Maximum concurrency` просело. **Причина:** буферы адаптеров и профилирование с фиктивными адаптерами съели часть бюджета. **Лечение:** снизить `--max-lora-rank` до реального максимума адаптеров, снизить `--max-loras`, ограничить `--lora-target-modules` или поднять `--gpu-memory-utilization`.
- **Подтверждение принятого значения:** в `/metrics` появляется gauge `vllm:lora_requests_info` с меткой `max_lora`; в логе старта — строки `Loaded new LoRA adapter: name '...', path '...'` для статических адаптеров.
- **Проверка наличия аргумента в вашей сборке:** `vllm serve --help` из нужного окружения — extract снят с исходников checkout'а, а принимает аргументы установленный пакет.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-lora --max-loras 2 --max-lora-rank 16 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --enable-lora --lora-modules sql=/models/lora/sql --max-loras 1 --max-lora-rank 32
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/lora.py`
- `vllm/vllm/v1/worker/lora_model_runner_mixin.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/engine/input_processor.py`
- `vllm/vllm/entrypoints/serve/lora/api_router.py`
- `vllm/docs/features/lora.md`
- `vllm/docs/usage/security.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
