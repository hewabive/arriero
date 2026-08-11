---
schema: 1
engine: vllm
primaryName: "--model-loader-extra-config"
title: "--model-loader-extra-config"
summary: JSON-словарь, который передается выбранному загрузчику весов. Набор допустимых ключей полностью определяется значением `--load-format`, а лишний или незнакомый ключ отвергается на старте, до загрузки модели.
group: LoadConfig
related:
  - --load-format
  - --safetensors-load-strategy
  - --download-dir
  - --tensor-parallel-size
  - --use-tqdm-on-load
  - --enable-ep-weight-filter
---

# --model-loader-extra-config

## Кратко

Это не «дополнительные опции загрузки вообще», а канал параметров ровно к тому классу-загрузчику, который выбран через `--load-format`. У каждого загрузчика свой закрытый набор ключей, и каждый проверяет его в конструкторе: неизвестный ключ приводит к `ValueError` на старте.

Аргумент принимает и строку JSON, и точечные под-флаги — `FlexibleArgumentParser` собирает `--model-loader-extra-config.num_threads 4` в тот же словарь.

## Оригинальная справка

```text
Extra config for model loader. This will be passed to the model loader
corresponding to the chosen load_format.
```

## Паспорт аргумента

- Флаги: `--model-loader-extra-config`
- Группа argparse: `LoadConfig`
- Тип значения: JSON-объект; поле объявлено как `dict | TensorizerConfig`, парсер — `union_dict_and_str` (строка, не похожая на `{...}`, останется строкой и будет отвергнута загрузчиком)
- Допустимые значения: `choices` нет; допустимые ключи задаются выбранным загрузчиком
- Значение по умолчанию: `Field(default_factory=dict)` — пустой словарь
- Эффективное значение: не переопределяется движком
- Где объявлен: `vllm/config/load.py:LoadConfig.model_loader_extra_config`
- Этап применения: конструктор загрузчика (валидация ключей) → чтение весов

## Что меняет в движке

Наборы ключей по загрузчикам:

- **`DefaultModelLoader`** (`auto`, `hf`, `safetensors`, `mistral`, `pt`, `npcache`, `fastsafetensors`, `instanttensor`): `enable_multithread_load` (bool), `num_threads` (положительное целое, по умолчанию 8), `enable_weights_track` (bool). Многопоточный режим включает `multi_thread_safetensors_weights_iterator` / `multi_thread_pt_weights_iterator` и **несовместим** с `--safetensors-load-strategy`, отличной от `None`/`lazy`. `enable_weights_track` управляет строгой проверкой «все параметры инициализированы из чекпоинта» (по умолчанию включена для неквантованных моделей).
- **`RunaiModelStreamerLoader`** (`runai_streamer`): `distributed` (bool), `concurrency` (положительное целое → `RUNAI_STREAMER_CONCURRENCY`), `memory_limit` (целое `>= -1` → `RUNAI_STREAMER_MEMORY_LIMIT`). Значения валидируются до записи в окружение, поэтому частично применённой конфигурации не бывает.
- **`ShardedStateLoader`** (`sharded_state`, `runai_streamer_sharded`): `pattern` (шаблон имени файла, по умолчанию `model-rank-{rank}-part-{part}.safetensors`).
- **`TensorizerLoader`** (`tensorizer`): ожидает вложенный объект `{"tensorizer_config": {...}}` с полями `TensorizerConfig` (`tensorizer_uri`, `tensorizer_dir`, `num_readers`, `encryption_keyfile`, `s3_*`, `stream_kwargs` и другие). Ключи `device`, `dtype`, `mode` запрещены на верхнем уровне.
- **`DummyModelLoader`** (`dummy`): любой непустой словарь — ошибка.
- **`ModelExpressModelLoader`** (`modelexpress`): конфигурация передается в загрузчик стороннего пакета.

## Значения и формат

Обе формы записи эквивалентны:

```bash
--model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 16}'
```

```bash
--model-loader-extra-config.enable_multithread_load true --model-loader-extra-config.num_threads 16
```

Точечная форма собирает вложенные объекты (`--model-loader-extra-config.tensorizer_config.num_readers 4`), а суффикс `+` собирает списки. Значения точечной формы разбираются как JSON, при неудаче — как человекочитаемое целое (`80m`), при неудаче — как строка.

- Пустой словарь эквивалентен незаданному аргументу.
- Строка без фигурных скобок пройдет разбор CLI, но `DefaultModelLoader` отвергнет ее сообщением `model_loader_extra_config must be a dict for load format <формат>`.
- Значения ключей проверяются по типу: `num_threads` строго положительное целое, `enable_multithread_load` строго bool.

## Когда использовать

- Ускорение загрузки крупного safetensors-чекпоинта с локального быстрого диска: `enable_multithread_load` + `num_threads` по числу физических ядер, обслуживающих I/O.
- Настройка потоковой загрузки Run:ai (конкурентность, лимит памяти, распределенный режим).
- Указание шаблона имен для пошардированного чекпоинта.
- Полная конфигурация Tensorizer, включая доступ к S3 и шифрование.
- Не используйте как «свалку» опций: любой ключ, не входящий в белый список выбранного загрузчика, — отказ старта, а не игнорирование.
- Не включайте `enable_multithread_load` вместе с `eager`/`prefetch`/`torchao`: комбинация явно отвергается, чтобы запрошенная стратегия не была тихо потеряна.

## Влияние на производительность и память

- **Время старта.** Основной смысл аргумента. Многопоточное чтение safetensors на локальном NVMe заметно сокращает фазу `Loading weights`; на сетевой ФС выигрыш меньше, чем от `--safetensors-load-strategy eager`/`prefetch`.
- **RAM хоста.** `enable_multithread_load` держит в памяти несколько файлов сразу (по одному на поток) — на крупных шардах это гигабайты; `memory_limit` у Run:ai ограничивает его буфер напрямую.
- **VRAM.** Не влияет.
- **Диск и сеть.** `concurrency` Run:ai определяет число параллельных потоков чтения из объектного хранилища.
- **Надежность.** `enable_weights_track: false` отключает проверку полноты загрузки — модель стартует, даже если часть параметров осталась неинициализированной. Отключайте только осознанно.

## Взаимодействие с другими аргументами

- `--load-format`: определяет, какой набор ключей допустим. Один и тот же ключ при другом формате станет ошибкой.
- `--safetensors-load-strategy`: жестко конфликтует с `enable_multithread_load` при значениях `eager`, `prefetch`, `torchao`.
- `--download-dir`: определяет, откуда читаются файлы, которые затем обрабатывает многопоточный итератор.
- `--tensor-parallel-size`: число рангов должно соответствовать шаблону `pattern` пошардированного чекпоинта.
- `--use-tqdm-on-load`: в многопоточном режиме прогресс-бар называется `Multi-thread loading shards` и считает файлы по мере завершения.
- `--enable-ep-weight-filter`: фильтрация экспертов по рангу работает в обычном однопоточном safetensors-итераторе; многопоточный режим ее не применяет.

## Типовые проблемы и диагностика

- **Симптом:** `Unexpected extra config keys for load format auto: {'concurrency'}` **Причина:** ключ от другого загрузчика. **Лечение:** сверить ключ с выбранным `--load-format`.
- **Симптом:** `enable_multithread_load does not support safetensors_load_strategy='eager'; the multi-thread loader only implements the default lazy strategy.` **Лечение:** выбрать одно из двух.
- **Симптом:** `model_loader_extra_config must be a dict for load format auto, got str` **Причина:** значение не распознано как JSON-объект (нет фигурных скобок или сломаны кавычки в shell). **Лечение:** заключить JSON в одинарные кавычки целиком либо использовать точечные под-флаги.
- **Симптом:** `num_threads must be a positive integer, got '8'` **Причина:** значение пришло строкой. **Лечение:** в JSON — без кавычек; в точечной форме значение `8` разбирается как число автоматически.
- **Симптом:** `Model loader extra config is not supported for load format dummy` **Лечение:** убрать аргумент или сменить формат.
- **Симптом:** `<ключ> is not an allowed Tensorizer argument.` **Причина:** `device`/`dtype`/`mode` в конфигурации Tensorizer — их выбирает движок. **Лечение:** удалить ключ.
- **Симптом:** OOM хоста в фазе загрузки. **Причина:** многопоточное чтение крупных шардов. **Лечение:** уменьшить `num_threads` или отключить многопоточность.

## Примеры

```bash
vllm serve /models/Qwen3-4B --load-format safetensors --model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 8}'
```

```bash
vllm serve /models/Qwen3-4B --load-format sharded_state --model-loader-extra-config.pattern "model-rank-{rank}-part-{part}.safetensors" --tensor-parallel-size 2
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/model_executor/model_loader/runai_streamer_loader.py`
- `vllm/vllm/model_executor/model_loader/sharded_state_loader.py`
- `vllm/vllm/model_executor/model_loader/tensorizer_loader.py`
- `vllm/vllm/model_executor/model_loader/tensorizer.py`
- `vllm/vllm/model_executor/model_loader/dummy_loader.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
