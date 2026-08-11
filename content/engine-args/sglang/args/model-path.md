---
schema: 1
engine: sglang
primaryName: "--model-path"
title: "--model-path"
summary: Обязательный аргумент — что именно сервер обслуживает. Локальный каталог, HF repo ID или URI объектного хранилища; из него же по умолчанию выводятся токенайзер, публичное имя модели и формат загрузки весов.
group: model
related:
  - --tokenizer-path
  - --served-model-name
  - --revision
  - --trust-remote-code
  - --load-format
  - --download-dir
  - --context-length
  - --model-config-parser
  - --kt-weight-path
---

# --model-path

## Кратко

`--model-path` — единственный обязательный аргумент `sglang.launch_server`: без него argparse завершает процесс с `the following arguments are required: --model-path/--model`. Значение не только указывает на веса: от него по цепочке зависят токенайзер (`--tokenizer-path`), публичное имя в `/v1/models` (`--served-model-name`), автоопределение формата загрузки (`gguf`, `mistral`, `runai_streamer`, `remote`) и весь блок model-specific настроек в `__post_init__` — attention backend, page size, KV-dtype по умолчанию. Менять его на живом сервере нельзя: это идентичность процесса.

## Оригинальная справка

```text
The path of the model weights. This can be a local folder or a Hugging Face repo ID.
```

## Паспорт аргумента

- Флаги: `--model-path`, алиас `--model`
- Группа: `model`
- Тип значения: строка (локальный путь, HF repo ID, `s3://`/`gs://`/`az://` URI, `<connector>://host:port/name`)
- Допустимые значения: не ограничены на уровне argparse
- Значение по умолчанию: отсутствует — поле датакласса объявлено без default, поэтому `add_cli_args` ставит `required=True` (`arg_groups/arg_utils.py`, ветка `arg_meta.required is None and default is _MISSING`)
- Эффективное значение: переписывается на пути ModelScope (`SGLANG_USE_MODELSCOPE=1` → `_handle_modelscope_paths` подменяет repo ID на локальный snapshot); специальные значения `none`/`dummy` (без учета регистра) обрывают весь `__post_init__` сразу после `_handle_return_hidden_states_mode`
- Где объявлен: `ServerArgs.model_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, обязательный
- Этап применения: разбор CLI → `__post_init__` (автоопределение load format, model-specific ветки) → `ModelConfig.from_server_args` (чтение `config.json`) → загрузка весов в каждом TP/PP-воркере

## Что меняет в движке

Значение попадает в `ServerArgs.model_path` и расходится по четырем маршрутам.

1. **Конфиг модели.** `ModelConfig.from_server_args` передает путь в `get_config()` (`sglang/python/sglang/srt/utils/hf_transformers/config.py`), где выбирается парсер (`--model-config-parser`), читается `config.json` и накладываются `--json-model-override-args`. Отсюда берутся архитектура, число слоев/голов, `max_position_embeddings` — то есть база для `--context-length` и для расчета размера KV-пула.
2. **Формат загрузки.** `_handle_load_format` смотрит на сам путь: `check_gguf_file(model_path)` → `load_format=gguf`; `_is_mistral_native_format()` (есть `consolidated*.safetensors` и нет `model*.safetensors`, либо имя матчится на mistral-large-3 / mistral-small-4 / leanstral) → `load_format=mistral`; `is_runai_obj_uri` (`s3://`, `gs://`, `az://`) → `runai_streamer`; любой другой `<схема>://` → `remote`.
3. **Производные имена.** `_handle_missing_default_values` подставляет `tokenizer_path = model_path` и `served_model_name = model_path`, если они не заданы. Значит, публичное имя модели в OpenAI-совместимом API по умолчанию равно строке пути — для локального каталога это некрасивый абсолютный путь, и его почти всегда стоит перебить `--served-model-name`.
4. **Model-specific ветки.** `_handle_model_specific_adjustments` диспетчеризуется по `hf_config.architectures[0]`, а не по имени пути; но чтобы получить архитектуру, движок уже должен прочитать конфиг по этому пути. Поэтому недоступный путь ломает старт раньше любых других проверок.

Веса читаются на этапе `ModelRunner.load_model` каждым воркером независимо — при `--tp-size N` файл читается N раз (`--weight-loader-prefetch-checkpoints` существует именно для сетевых ФС).

## Значения и формат

- **Локальный каталог** — обычный случай: каталог с `config.json` и весами. Проверка существования отдельно не делается: ошибка приходит из `transformers` при чтении конфига.
- **HF repo ID** (`org/name`) — конфиг и токенайзер тянутся через обычный HF-кеш, веса — через `download_weights_from_hf` с `cache_dir=--download-dir`. Требуется сеть на старте; версия фиксируется через `--revision`.
- **GGUF-файл** — путь указывает на *файл*, а не каталог: `GGUFModelLoader._prepare_weights` явно требует `os.path.isfile`, иначе `ValueError: … is not a file.` Конфиг при этом читается из каталога-родителя.
- **`s3://`, `gs://`, `az://`** — RunAI Model Streamer; `_handle_model_source_paths` заранее скачивает метаданные (`ObjectStorageModel.download_and_get_path`).
- **`<схема>://…`** прочих видов — connector-путь; `instance://` (`ConnectorType.INSTANCE`) — это режим получения весов от другого инстанса, он же отключает часть обычных проверок.
- **`none` / `dummy`** (без учета регистра) — служебное значение: `__post_init__` возвращается сразу, ни одна model-specific настройка не применяется. Для профилирования с настоящей архитектурой нужен реальный путь плюс `--load-format dummy`, а не `--model-path dummy`.
- Пробелы и кириллица в пути не запрещены, но `served_model_name` по умолчанию унаследует их целиком — задавайте `--served-model-name` явно.

## Когда использовать

- Задается всегда. Осмысленный выбор здесь — не «задавать или нет», а «локальный каталог или repo ID»: локальный путь дает предсказуемое время старта, repo ID означает возможную загрузку десятков гигабайт при первом запуске.
- Для повторяемых запусков всегда указывайте локальный каталог со снятым снапшотом плюс `--revision`, если путь все же удаленный.
- Не пытайтесь через `--model-path` подсунуть каталог с уже сконвертированными CPU-весами KTransformers: для них есть отдельный `--kt-weight-path`, а `--model-path` продолжает указывать на исходную модель.

## Влияние на производительность и память

- VRAM: путь определяет, какие веса и в какой квантизации загрузятся, то есть основную часть статического расхода. Остаток `--mem-fraction-static` после весов уходит в KV-пул.
- Время старта: локальный NVMe — минуты на десятки гигабайт; HF repo ID при холодном кеше — неограниченно, скачивание идет внутри процесса запуска и не имеет отдельного таймаута.
- RAM хоста: чтение safetensors идет через mmap (отключается `--weight-loader-disable-mmap`), поэтому страницы модели оседают в page cache; на хосте с KTransformers это конкурирует с CPU-весами экспертов.
- Фактические цифры печатает строка `Load weight end. elapsed=… s, type=…, avail mem=… GB, mem usage=… GB.`

## Взаимодействие с другими аргументами

- `--tokenizer-path`, `--served-model-name`: наследуют значение, если не заданы явно.
- `--load-format`: автоматически переопределяется по виду пути (см. выше). Явно заданный формат при этом всё равно может быть перекрыт — `gguf`-детект и runai/remote-детект срабатывают безусловно.
- `--download-dir`: влияет только на путь скачивания *весов* с HF (и на ModelScope-кеш), но не на скачивание `config.json`/токенайзера — те идут в стандартный HF-кеш.
- `--revision`: версия, с которой резолвится удаленный путь.
- `--trust-remote-code`: нужен, если в каталоге модели лежит собственный код (`auto_map`).
- `--context-length`: значение по умолчанию выводится из `config.json` по этому пути.
- `--model-checksum`: проверяет целостность файлов уже разрешенного каталога.
- `--delete-ckpt-after-loading`: удаляет **этот** каталог после старта. Комбинация с локальным путем к единственной копии модели необратима.
- `--kt-weight-path`: отдельный путь к CPU-весам KTransformers; `--model-path` при KT-профиле по-прежнему указывает на основную модель.

В arriero для инстансов kind `ktransformers` ключи `--model-path` и `--model` **запрещены в сыром `args`**: схема инстанса отклоняет их с сообщением «managed by KTransformers engine config», а флаг собирается из типизированной конфигурации движка (`docs/KTRANSFORMERS_SUPPORT.md`). Это сделано, чтобы UI-значение и сырые аргументы не расходились молча.

## Типовые проблемы и диагностика

- `the following arguments are required: --model-path/--model` — аргумент не передан вовсе.
- `OSError: … does not appear to have a file named config.json` (или HF-эквивалент) — путь есть, но это не каталог модели. Проверьте, не указали ли вы каталог с GGUF вместо самого файла.
- `ValueError: <path> is not a file.` — `load_format=gguf` (автодетект или явный), а путь ведет на каталог.
- Модель в `/v1/models` называется `/models/very/long/path` — сработал дефолт `served_model_name = model_path`; задайте `--served-model-name`.
- Старт «висит» без логов на минуты — идет скачивание с HF. Подтверждается строкой `Using model weights format ['*.safetensors']` и последующей паузой; лечится локальным снапшотом.
- Значение, как его принял движок (уже после ModelScope-резолва и автодетекта формата), видно в дампе `server_args=` при старте — это единственный надежный способ убедиться, что путь тот самый.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --served-model-name qwen3-30b --port 30000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-30B-A3B --revision main --download-dir /models/hf-cache --served-model-name qwen3-30b
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
- `sglang/python/sglang/srt/utils/runai_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/KTRANSFORMERS_SUPPORT.md`
