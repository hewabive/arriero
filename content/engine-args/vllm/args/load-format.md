---
schema: 1
engine: vllm
primaryName: "--load-format"
title: "--load-format"
summary: Выбирает загрузчик весов и набор скачиваемых файлов. `auto` (по умолчанию) сам решает между обычным HF-чекпоинтом и консолидированным mistral-форматом; остальные значения нужны либо для ускорения холодного старта, либо для профилирования без весов.
group: LoadConfig
related:
  - --model
  - --download-dir
  - --ignore-patterns
  - --model-loader-extra-config
  - --safetensors-load-strategy
  - --pt-load-map-location
  - --use-tqdm-on-load
  - --quantization
  - --tensor-parallel-size
---

# --load-format

## Кратко

Значение решает две вещи сразу: какой класс-загрузчик создаст `get_model_loader()` и какие шаблоны файлов уйдут в `allow_patterns` при скачивании. Большая часть значений (`auto`, `hf`, `safetensors`, `pt`, `npcache`, `mistral`, `fastsafetensors`, `instanttensor`) обслуживается одним `DefaultModelLoader` и различается именно набором файлов и способом их чтения; `bitsandbytes`, `tensorizer`, `runai_streamer`, `sharded_state`, `modelexpress`, `dummy` — отдельные загрузчики.

Список допустимых значений в декларации есть, но argparse его **не** проверяет. Тип поля записан как `str | LoadFormats`, а `LoadFormats` вне проверки типов равен обычному `str`, поэтому в runtime аннотация схлопывается в `str` и аргумент получает `type=str` без `choices`. Любая строка проходит разбор CLI и отвергается позже — при создании загрузчика.

## Оригинальная справка

```text
The format of the model weights to load.

- "auto" will try to load the weights in the safetensors format and fall
  back to the pytorch bin format if safetensors format is not available.
- "pt" will load the weights in the pytorch bin format.
- "safetensors" will load the weights in the safetensors format.
- "instanttensor" will load the Safetensors weights on CUDA devices using
  InstantTensor, which enables distributed loading with pipelined prefetching
  and fast direct I/O.
- "npcache" will load the weights in pytorch format and store a numpy cache
  to speed up the loading.
- "dummy" will initialize the weights with random values, which is mainly
  for profiling.
- "tensorizer" will use CoreWeave's tensorizer library for fast weight
  loading. See the Tensorize vLLM Model script in the Examples section for
  more information.
- "runai_streamer" will load the Safetensors weights using Run:ai Model
  Streamer.
- "runai_streamer_sharded" will load weights from pre-sharded checkpoint
  files using Run:ai Model Streamer.
- "bitsandbytes" will load the weights using bitsandbytes quantization.
- "sharded_state" will load weights from pre-sharded checkpoint files,
  supporting efficient loading of tensor-parallel models.
- "mistral" will load weights from consolidated safetensors files used by
  Mistral models.
- "modelexpress" will load weights using ModelExpress.
- Other custom values can be supported via plugins.
```

## Паспорт аргумента

- Флаги: `--load-format`
- Группа argparse: `LoadConfig`
- Тип значения: enum-подобная строка; значение приводится к нижнему регистру валидатором `_lowercase_load_format`
- Допустимые значения: `auto`, `hf`, `bitsandbytes`, `dummy`, `fastsafetensors`, `instanttensor`, `mistral`, `modelexpress`, `npcache`, `pt`, `runai_streamer`, `runai_streamer_sharded`, `safetensors`, `sharded_state`, `tensorizer`. Список расширяется плагинами через `register_model_loader(...)`; ни argparse, ни валидация pydantic его не проверяют — единственная проверка происходит в `get_model_loader()`
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается уже внутри `DefaultModelLoader._prepare_weights` — в `mistral`, если в репозитории есть `consolidated*.safetensors`, иначе в `hf`. Отдельно `DefaultModelLoader.load_weights` может подменить стратегию чтения на `torchao` (это `--safetensors-load-strategy`, а не смена формата)
- Где объявлен: `vllm/config/load.py:LoadConfig.load_format`
- Этап применения: создание загрузчика → подготовка/скачивание весов → чтение весов

## Что меняет в движке

**Выбор загрузчика** (`vllm/model_executor/model_loader/__init__.py`):

| Значение | Класс загрузчика |
| --- | --- |
| `auto`, `hf`, `safetensors`, `fastsafetensors`, `instanttensor`, `mistral`, `npcache`, `pt` | `DefaultModelLoader` |
| `bitsandbytes` | `BitsAndBytesModelLoader` |
| `dummy` | `DummyModelLoader` |
| `tensorizer` | `TensorizerLoader` |
| `runai_streamer` | `RunaiModelStreamerLoader` |
| `runai_streamer_sharded`, `sharded_state` | `ShardedStateLoader` |
| `modelexpress` | `ModelExpressModelLoader` |

**Набор файлов** в `DefaultModelLoader._prepare_weights`: `hf` → `["*.safetensors", "*.bin"]`; `safetensors`/`fastsafetensors`/`instanttensor` → `["*.safetensors"]`; `mistral` → `["consolidated*.safetensors"]` и индекс `consolidated.safetensors.index.json`; `pt` → `["*.pt"]`; `npcache` → `["*.bin"]`. Для явно safetensors-форматов отключается запасной вариант `*.pt`, чтобы `.pt`-файл не был случайно открыт как safetensors.

**Способ чтения**: `npcache` конвертирует веса в numpy-файлы в подкаталоге `np/` внутри каталога модели (каталог должен быть доступен на запись) и на последующих стартах читает их; `fastsafetensors` и `instanttensor` используют собственные итераторы; остальные safetensors-пути идут через `safetensors_weights_iterator`, где и применяется `--safetensors-load-strategy`; `.bin`/`.pt` читаются через `torch.load` с `--pt-load-map-location`.

## Значения и формат

- Регистр не важен — значение приводится к нижнему.
- `auto` — рабочий дефолт: пробует safetensors, при отсутствии откатывается к pytorch bin (через `hf`, чей `allow_patterns` включает оба).
- `dummy` — инициализация случайными весами. Скачивания весов нет, но конфигурация и токенизатор все равно нужны. Используется для профилирования памяти и времени; любой `--model-loader-extra-config` при этом формате отвергается.
- `sharded_state` и `runai_streamer_sharded` требуют заранее подготовленный пошардированный чекпоинт; шаблон имен настраивается ключом `pattern` в `--model-loader-extra-config` (по умолчанию `model-rank-{rank}-part-{part}.safetensors`).
- `tensorizer` требует `--model-loader-extra-config '{"tensorizer_config": {...}}'`; ключи `device`, `dtype`, `mode` в нем запрещены.
- `bitsandbytes` — загрузка через `BitsAndBytesModelLoader`: уже квантованные bnb-чекпойнты (4-битный nf4 и 8-битный) читаются как есть, неквантованные веса квантуются на лету (`quantize_4bit`, nf4). Требует пакет `bitsandbytes>=0.46.1`, иначе `ImportError` с инструкцией. Задавать формат руками обычно не нужно: `--quantization bitsandbytes` (или bnb-`quantization_config` в чекпойнте) сам переключает `load_format` на `bitsandbytes`. С уже квантованным bnb-чекпойнтом tensor parallelism не работает.
- `modelexpress` требует установленного пакета `modelexpress`, иначе — `ImportError` с прямой инструкцией.
- В тексте справки не упомянуты два валидных значения: `hf` (в него разрешается `auto`) и `fastsafetensors`.
- Неизвестное значение (в том числе опечатка) даст `Load format `<значение>` is not supported` уже после разбора CLI.

## Когда использовать

- Оставьте `auto`, если нет конкретной причины. Он корректно обрабатывает и обычные HF-репозитории, и mistral-формат.
- `safetensors` — когда нужно гарантированно исключить чтение `.bin`/`.pt` (безопасность: `torch.load` исполняет pickle, хотя vLLM и вызывает его с `weights_only=True`).
- `runai_streamer` / `instanttensor` / `fastsafetensors` — оптимизация холодного старта на быстром хранилище или объектном сторадже; требуют дополнительных пакетов и собственной квалификации.
- `dummy` — измерение памяти и времени старта без реальных весов; для выдачи осмысленного текста непригоден.
- `sharded_state` — быстрый повторный старт большой tensor-parallel конфигурации из заранее сохраненных шардов.
- Не меняйте формат ради «ускорения» без замера: выигрыш зависит от файловой системы и часто перекрывается стратегией чтения safetensors.

## Влияние на производительность и память

- **Время старта.** Основной измеримый эффект. `npcache` окупается только со второго старта; `sharded_state`/`runai_streamer_sharded` экономят на распределении весов по рангам; `dummy` убирает загрузку целиком.
- **Диск.** `npcache` создает вторую копию весов в numpy-формате внутри каталога модели.
- **RAM хоста.** Зависит от связки с `--safetensors-load-strategy`: `eager` читает файл в память целиком, `lazy` использует mmap.
- **VRAM.** Не влияет: формат определяет, откуда берутся тензоры, а не сколько их.
- **Корректность.** `dummy` дает случайные веса — не перепутайте на продовом инстансе; симптом однозначный (бессвязный вывод при полностью здоровом сервере).

## Взаимодействие с другими аргументами

- `--model`: локальный путь отключает скачивание, но не выбор загрузчика — формат по-прежнему определяет, какие файлы будут найдены `glob`-ом в каталоге.
- `--download-dir`, `--ignore-patterns`: применяются только на пути скачивания и только для форматов, обслуживаемых `DefaultModelLoader`.
- `--model-loader-extra-config`: набор допустимых ключей задается именно выбранным форматом; лишний ключ — ошибка старта.
- `--safetensors-load-strategy`: применяется только к обычному safetensors-итератору (`auto`/`hf`/`safetensors`/`mistral`), но не к `fastsafetensors`, `instanttensor` и не к многопоточному режиму.
- `--pt-load-map-location`: применяется только к `.bin`/`.pt`, то есть к `pt`, `npcache` и к `hf`/`auto`, когда safetensors в репозитории нет.
- `--use-tqdm-on-load`: включает прогресс-бары загрузки для всех форматов, идущих через общие итераторы.
- `--quantization`: чтение конфигурации квантизации происходит независимо от формата; для `torchao`-чекпоинтов формат остается safetensors, а меняется стратегия чтения. Исключение — `bitsandbytes`: метод квантизации жестко привязан к своему загрузчику, и `create_load_config` / `create_engine_config` перезаписывают `load_format` на `bitsandbytes` независимо от заданного значения.
- `--tensor-parallel-size`: обязателен к согласованию с `sharded_state` — число шардов должно соответствовать числу рангов.

## Типовые проблемы и диагностика

- **Симптом:** ``Load format `safe_tensors` is not supported`` **Причина:** опечатка; argparse не проверяет значение, потому что тип допускает произвольную строку. **Лечение:** сверить со списком допустимых значений и с `vllm serve --help` установленной версии.
- **Симптом:** `Cannot find any model weights with <model>` **Причина:** формат задает `allow_patterns`, под которые в репозитории/каталоге нет файлов (например, `--load-format pt` на safetensors-модели). **Лечение:** вернуть `auto`.
- **Симптом:** модель отдает бессмыслицу при полностью здоровом старте. **Причина:** `--load-format dummy`. **Лечение:** убрать.
- **Симптом:** `Model loader extra config is not supported for load format dummy` **Лечение:** убрать `--model-loader-extra-config`.
- **Симптом:** `The 'modelexpress' load format requires the ModelExpress Python package. Install it with `pip install modelexpress`.` **Лечение (arriero):** окружения неизменяемы — соберите новое окружение с нужным пакетом (`docs/ENVIRONMENTS.md`), а не доустанавливайте в существующее.
- **Симптом:** `npcache` падает на записи. **Причина:** каталог модели недоступен на запись — numpy-кэш пишется в `<каталог модели>/np`. **Лечение:** сменить формат или права.
- **Подтверждение принятого значения:** отладочная строка `Using model weights format <allow_patterns>` (уровень debug) и последующая `Loading weights took X.XX seconds`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --load-format safetensors --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --load-format dummy --max-model-len 8192 --max-num-seqs 4
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/__init__.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/model_executor/model_loader/bitsandbytes_loader.py`
- `vllm/vllm/model_executor/model_loader/dummy_loader.py`
- `vllm/vllm/model_executor/model_loader/sharded_state_loader.py`
- `vllm/vllm/model_executor/model_loader/tensorizer_loader.py`
- `vllm/vllm/model_executor/model_loader/runai_streamer_loader.py`
- `vllm/vllm/model_executor/model_loader/modelexpress_loader.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/engine/arg_utils.py`
- `docs/ENVIRONMENTS.md` (arriero)
