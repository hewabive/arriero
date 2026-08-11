---
schema: 1
engine: sglang
primaryName: "--enable-lora"
title: "--enable-lora"
summary: Главный выключатель multi-LoRA. Включается автоматически, если задан `--lora-paths`; при включении требует либо стартовых адаптеров, либо явных `--max-lora-rank` и `--lora-target-modules`, и запрещает спекулятивное декодирование кроме NGRAM.
group: lora
related:
  - --lora-paths
  - --max-lora-rank
  - --lora-target-modules
  - --max-loras-per-batch
  - --max-loaded-loras
  - --lora-backend
  - --enable-lora-overlap-loading
  - --speculative-algorithm
  - --cuda-graph-backend-prefill
---

# --enable-lora

## Кратко

`--enable-lora` включает весь LoRA-тракт: оборачивание целевых модулей в LoRA-слои, создание `LoRAManager`, выделение GPU-пула адаптеров, HTTP-эндпоинты `/load_lora_adapter` и `/unload_lora_adapter`, отображение адаптеров в `GET /v1/models`. Отдельно задавать его обычно не приходится: `--lora-paths` включает LoRA сам. Флаг нужен, когда адаптеры загружаются динамически и стартовых путей нет — тогда вместе с ним обязательны `--max-lora-rank` и `--lora-target-modules`.

## Оригинальная справка

```text
Enable LoRA support for the model. This argument is automatically set to True if `--lora-paths` is provided for backward compatibility.
```

## Паспорт аргумента

- Флаги: `--enable-lora`
- Группа: `lora`
- Тип значения: `Optional[bool]`; в argparse — `action="store_true"` с `default=None`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `null`
- Эффективное значение: `check_lora_server_args` переводит `None` в `True`, если задан `--lora-paths`; кроме того, при diffusion-LLM инференсе (`--dllm-algorithm`) значение принудительно сбрасывается в `False` с предупреждением
- Где объявлен: `ServerArgs.enable_lora`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `check_lora_server_args` (валидация и разрешение) → `ModelRunner.maybe_init_lora_manager` после загрузки весов → планировщик и forward

## Что меняет в движке

### Разрешение значения

`check_lora_server_args` (`sglang/python/sglang/srt/server_args.py`):

- если `--lora-paths` непустой и `enable_lora is None` — значение поднимается до `True` через механизм поздней резолюции, в лог уходит `--enable-lora is set to True because --lora-paths is provided.`;
- если `--lora-paths` задан, а `enable_lora` явно `False` (это достижимо только из Python-API, см. ниже) — предупреждение `--enable-lora is set to False, any provided lora_paths will be ignored.`;
- при включенном LoRA `--enable-lora-overlap-loading`, если он не задан, фиксируется в `False`.

Как и `--enable-multimodal`, поле объявлено `Optional[bool]`, но argparse делает из него `store_true`. Значит из командной строки его можно только включить: пары `--no-enable-lora` нет, и YAML через `--config` при `enable_lora: false` просто не добавит флаг. Ветка «явный `False`» достижима лишь через `ServerArgs(enable_lora=False)` / `sglang.Engine(...)`.

### Проверки, которые включаются вместе с флагом

- `assert self.max_loras_per_batch > 0`;
- спекулятивное декодирование: `if self.speculative_algorithm not in ["NGRAM", None]: raise ValueError("Currently LoRA is only compatible with NGRAM speculative decoding.")`;
- разбор `--lora-paths` в объекты `LoRARef` (формат `<PATH>`, `<NAME>=<PATH>` или JSON);
- нормализация `--lora-target-modules` в множество, с требованием, чтобы `all` был единственным элементом;
- ключевое требование к динамическому режиму: `assert self.lora_paths or (self.max_lora_rank and self.lora_target_modules)` с текстом *When no initial --lora-paths is provided, you need to specify both --max-lora-rank and --lora-target-modules for LoRA initialization.*;
- проверки `--max-loaded-loras`, `--max-lora-chunk-size`, `--lora-drain-wait-threshold`.

### Что появляется в рантайме

- `ModelRunner.init_lora_manager` создает `LoRAManager`, который оборачивает целевые модули (`init_lora_modules`), выделяет `LoRAMemoryPool` на `max_loras_per_batch` слотов и сразу загружает в него «базовый» слот (`fetch_new_loras({None})`).
- Планировщик получает дополнительное ограничение: заявка исполняется только если её адаптер уже в батче или помещается (`_can_schedule_lora_req`).
- CUDA graph: при LoRA создается отдельная статическая метаинформация батча (`init_cuda_graph_batch_info`), а piecewise-захват prefill отключается правилом «LoRA» — Dynamo не переживает перепривязку `LoRABatchInfo` на каждом батче.
- HTTP: включаются `/load_lora_adapter`, `/load_lora_adapter_from_tensors`, `/unload_lora_adapter`, а `GET /v1/models` начинает отдавать каждый загруженный адаптер отдельной карточкой с `parent` = базовая модель.
- Метрики (`--enable-metrics`): появляются `sglang:lora_pool_slots_used`, `sglang:lora_pool_slots_total`, `sglang:lora_pool_utilization`.
- Динамическая загрузка требует `--dp-size 1` либо `--enable-dp-attention` — это ассерт в `tokenizer_control_mixin.py`.

## Значения и формат

- Флаг без значения. `--enable-lora true` argparse отвергнет.
- Отсутствие флага при заданном `--lora-paths` эквивалентно его наличию.
- Отсутствие и флага, и путей означает «LoRA выключена»: запрос с `lora_path` получит `LoRA adapter '<name>' was requested, but LoRA is not enabled. Please launch the server with --enable-lora flag and preload adapters using --lora-paths or /load_lora_adapter endpoint.`

## Когда использовать

- Адаптеры загружаются только динамически через HTTP: тогда `--enable-lora` обязателен, и к нему обязательны `--max-lora-rank` и `--lora-target-modules` — иначе движку нечем определить форму буферов пула.
- Хотите включить LoRA, но пока без адаптеров (заготовка под последующую загрузку).
- **Не задавайте** вместе с `--lora-paths` — это дублирование без эффекта.
- **Не включайте «на всякий случай»**: пул адаптеров выделяется на старте и безусловно уменьшает KV-кеш, даже если ни один запрос LoRA не использует.

## Влияние на производительность и память

- **VRAM.** `LoRAMemoryPool` выделяется в `ModelRunner.initialize()`, то есть **до** профилирования KV-пула. Профилирование считает бюджет по фактически свободной памяти, поэтому весь объем LoRA-буферов вычитается из `max_total_num_tokens` один к одному. Размер считается по `--max-loras-per-batch × --max-lora-rank × Σ(размеры целевых модулей) × число слоев × размер элемента`.
- **RAM хоста.** Веса каждого загруженного адаптера кешируются на CPU (`LoRAManager.loras`), а при `--enable-lora-overlap-loading` еще и закрепляются (pinned).
- **Latency.** Каждый LoRA-модуль добавляет к базовому GEMM пару операций (A- и B-проекции), которые исполняет выбранный `--lora-backend`. На батче с одним адаптером накладные расходы небольшие; на батче с несколькими они зависят от backend'а.
- **Throughput.** Планировщик не может собрать в один батч больше `--max-loras-per-batch` различных адаптеров (базовая модель тоже занимает слот), поэтому при перекошенном трафике часть заявок ждет.
- **Время старта.** Плюс загрузка адаптеров из `--lora-paths` и аллокация пула.

## Взаимодействие с другими аргументами

- `--lora-paths`: включает LoRA автоматически и служит источником вывода `max_lora_rank`/`target_modules`, если те не заданы.
- `--max-lora-rank`, `--lora-target-modules`: обязательная пара при пустом `--lora-paths`.
- `--max-loras-per-batch`: число слотов GPU-пула; `--max-loaded-loras` — потолок числа адаптеров, кешированных в RAM.
- `--lora-backend`, `--max-lora-chunk-size`: реализация ядер.
- `--speculative-algorithm`: совместимо только `NGRAM`, всё остальное — `ValueError`.
- `--cuda-graph-backend-prefill`: piecewise-захват prefill при LoRA отключается автоматически.
- `--dp-size`, `--enable-dp-attention`: динамическая загрузка требует `dp_size == 1` или DP-attention.
- В arriero объявленный memory draw инстанса должен включать LoRA-пул — иначе планировщик прокси будет считать, что VRAM больше, чем есть (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `AssertionError: When no initial --lora-paths is provided, you need to specify both --max-lora-rank and --lora-target-modules for LoRA initialization.` — самая частая ошибка запуска в динамическом режиме.
- `ValueError: Currently LoRA is only compatible with NGRAM speculative decoding.` — включены LoRA и EAGLE/MTP одновременно.
- Запрос с `lora_path` получает `... but LoRA is not enabled` — сервер поднят без флага и без путей.
- `AssertionError: dp_size must be 1 or dp attention must be enabled for dynamic lora loading` — попытка загрузить адаптер по HTTP при DP > 1.
- KV-пул неожиданно меньше ожидаемого — это пул адаптеров; сравните `max_total_num_tokens` в стартовой строке планировщика с прогоном без LoRA.
- Подтверждение включения в логе: `--enable-lora is set to True because --lora-paths is provided.` (если сработал автоподъем) и `Using <backend> as backend of LoRA kernels.` при инициализации менеджера. Значение поля видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 64 --lora-target-modules all --max-loras-per-batch 4
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --lora-paths sql=/models/lora/sql code=/models/lora/code --max-loras-per-batch 3 --lora-backend csgmv
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
