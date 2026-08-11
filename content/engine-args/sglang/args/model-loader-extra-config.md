---
schema: 1
engine: sglang
primaryName: "--model-loader-extra-config"
title: "--model-loader-extra-config"
summary: JSON с параметрами конкретного загрузчика весов. Набор допустимых ключей полностью зависит от `--load-format`, и лишний ключ — не предупреждение, а отказ на старте.
group: model
related:
  - --load-format
  - --model-path
  - --weight-loader-prefetch-checkpoints
  - --weight-loader-disable-mmap
  - --download-dir
  - --speculative-draft-load-format
---

# --model-loader-extra-config

## Кратко

Аргумент — это JSON-объект, который попадает в `LoadConfig.model_loader_extra_config` и разбирается конструктором загрузчика, выбранного `--load-format`. Общего набора ключей нет: каждый загрузчик знает свой список и **валидирует его строго** — неизвестный ключ приводит к `ValueError` при старте, а не к молчаливому игнорированию. Часть загрузчиков (`dummy`, `gguf`) не принимает никакой extra-config вообще.

## Оригинальная справка

```text
Extra config for model loader. This will be passed to the model loader corresponding to the chosen load_format. For load_format=presharded, JSON may include presharded_path (target cache root), draft_presharded_path (draft cache root), max_file_bytes, hash_num_threads, and verify_on_load.
```

## Паспорт аргумента

- Флаги: `--model-loader-extra-config`
- Группа: `model`
- Тип значения: строка с JSON-объектом
- Допустимые значения: зависят от загрузчика (перечень ниже); синтаксически — любой валидный JSON-объект
- Значение по умолчанию: `"{}"`
- Эффективное значение: `LoadConfig.__post_init__` разбирает строку через `orjson.loads` в словарь; `PreshardedModelLoader` дополнительно **изымает** свои ключи из словаря перед тем, как передать остаток базовому загрузчику
- Где объявлен: `ServerArgs.model_loader_extra_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструирование загрузчика перед чтением весов

## Что меняет в движке

Ключи по загрузчикам — по коду `sglang/python/sglang/srt/model_loader/loader.py`:

- **`DefaultModelLoader`** (`auto`, `safetensors`, `pt`, `npcache`, `mistral`, `fastsafetensors`): `enable_multithread_load`, `num_threads`; для `fastsafetensors` дополнительно `enable_gds` (обязан быть булевым). Всё прочее — `ValueError` с перечнем неожиданных ключей.
- **`PreshardedModelLoader`**: `presharded_path`, `draft_presharded_path`, `max_file_bytes` (по умолчанию 20 ГиБ), `hash_num_threads` (по умолчанию 8), `verify_on_load` (по умолчанию False). Эти ключи вынимаются из словаря, после чего остаток проверяется правилами `DefaultModelLoader`.
- **`ShardedStateLoader`** (`sharded_state`): `pattern`, по умолчанию `model-rank-{rank}-part-{part}.safetensors`.
- **`BitsAndBytesModelLoader`**: `qlora_adapter_name_or_path`.
- **`RunaiModelStreamerLoader`**: `distributed`, `concurrency`, `memory_limit`.
- **`DummyModelLoader`, `GGUFModelLoader`**: любой непустой словарь — `ValueError: Model loader extra config is not supported for load format …`.

Отдельно стоит `enable_multithread_load`: при `--weight-loader-prefetch-checkpoints` многопоточное чтение safetensors выключается по умолчанию, чтобы не конкурировать с потоками префетча, и этот ключ — единственный способ вернуть его (осмысленно на локальном NVMe, где префетч бесполезен).

## Значения и формат

- Одна строка JSON, в shell — в одинарных кавычках.
- Невалидный JSON падает при построении `LoadConfig` (`orjson`), а не в argparse.
- `{}` эквивалентно незаданному аргументу.
- Пути внутри (`presharded_path`, `draft_presharded_path`) должны быть доступны **всем** rank'ам и узлам на запись: `presharded` дампит туда пошардованный чекпоинт. К каждому из них движок дополнительно приписывает подкаталог, зависящий от параллелизма и квантизации.
- Булевы значения пишутся как JSON (`true`/`false`), не как строки: `enable_gds` проверяется на `isinstance(..., bool)`.

## Когда использовать

- `presharded_path` — когда `--model-path` только для чтения (например смонтированный HF-кеш), а `presharded` требует записываемого места.
- `enable_multithread_load: true` — при включенном префетче на локальном быстром диске.
- `pattern` — если ваш пошардованный чекпоинт назван не по умолчанию.
- `distributed`/`concurrency`/`memory_limit` — тюнинг RunAI Streamer при чтении из объектного хранилища.
- Во всех остальных случаях аргумент не нужен: у него нет «полезных значений по умолчанию», которые стоило бы переопределять.

## Влияние на производительность и память

- `enable_multithread_load` и `num_threads` напрямую меняют время чтения весов и нагрузку на диск/сеть.
- `hash_num_threads` и `max_file_bytes` определяют скорость и гранулярность дампа presharded-чекпоинта; `verify_on_load` добавляет проверку хешей при каждом чтении — это плата временем старта за уверенность в целостности.
- `memory_limit` у RunAI Streamer ограничивает буфер чтения, то есть пиковую RAM хоста при загрузке.
- На работу сервера после старта аргумент не влияет вовсе.

## Взаимодействие с другими аргументами

- `--load-format`: определяет, какой набор ключей вообще допустим. Меняя формат, проверьте extra-config — иначе старт упадет.
- `--weight-loader-prefetch-checkpoints`: меняет дефолт `enable_multithread_load`.
- `--weight-loader-disable-mmap`: соседняя ручка чтения safetensors, задается отдельным флагом, а не здесь.
- `--speculative-draft-load-format`: draft-модель использует тот же словарь; `draft_presharded_path` существует именно для нее.
- `--download-dir`: определяет, откуда берутся файлы, extra-config — как они читаются.

## Типовые проблемы и диагностика

- `ValueError: Unexpected extra config keys for load format …: {'…'}` — ключ не из списка выбранного загрузчика.
- `ValueError: Model loader extra config is not supported for load format LoadFormat.DUMMY` (или `GGUF`) — эти загрузчики не принимают конфиг совсем.
- `ValueError: enable_gds in --model-loader-extra-config must be a boolean` — значение передано строкой.
- Ошибка записи при `presharded` — каталог назначения недоступен на запись или не общий для rank'ов; задайте `presharded_path`.
- JSON-ошибка на старте — кавычки съедены shell'ом.
- Значение, как его принял движок, — в дампе `server_args=` (строкой, до разбора).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --load-format presharded --model-loader-extra-config '{"presharded_path": "/fast/presharded", "verify_on_load": true}' --tp-size 2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-loader-prefetch-checkpoints --model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 8}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
