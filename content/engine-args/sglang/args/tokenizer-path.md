---
schema: 1
engine: sglang
primaryName: "--tokenizer-path"
title: "--tokenizer-path"
summary: Откуда грузится токенизатор и мультимодальный процессор, если он лежит не там же, где веса. Не задан — молча равен --model-path; ошибка в значении даст не отказ старта, а испорченный вывод.
group: serving
related:
  - --model-path
  - --tokenizer-mode
  - --tokenizer-backend
  - --skip-tokenizer-init
  - --revision
  - --trust-remote-code
  - --download-dir
  - --served-model-name
---

# --tokenizer-path

## Кратко

`--tokenizer-path` указывает, откуда грузить токенизатор. Если аргумент не задан, `_handle_missing_default_values` присваивает `tokenizer_path = model_path` — обычный и правильный случай.

Особенность, ради которой стоит держать этот аргумент в голове: **несовпадающий токенизатор не диагностируется**. Движок загрузит его без ошибок, сервер поднимется, `/health` вернет 200, а генерация будет выдавать связный на вид, но неправильный текст. Никакой сверки словаря с `config.json` модели на этом пути нет.

## Оригинальная справка

```text
The path of the tokenizer.
```

## Паспорт аргумента

- Флаги: `--tokenizer-path`
- Группа: `serving`
- Тип значения: str — локальный каталог, HF repo ID, `.json`-файл в формате tiktoken или URI объектного хранилища
- Допустимые значения: `choices` нет
- Значение по умолчанию: `None`
- Эффективное значение: **переопределяется всегда, когда не задано.** `__post_init__` → `_handle_missing_default_values`: `if self.tokenizer_path is None: self.tokenizer_path = self.model_path`. Дополнительно значение переписывается при `SGLANG_USE_MODELSCOPE=1` (`_handle_modelscope_paths` скачивает snapshot с `ignore_patterns=["*.bin", "*.safetensors"]`, то есть только файлы токенизатора) и предварительно прогревается `_handle_model_source_paths`, если это `s3://`/`gs://`/`az://`
- Где объявлен: `ServerArgs.tokenizer_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подстановка и резолв путей) → инициализация процессов tokenizer, detokenizer, scheduler и tp-worker — каждый читает токенизатор независимо

## Что меняет в движке

Один и тот же путь читают несколько процессов, и каждый строит собственный экземпляр:

- `TokenizerManager.__init__` — основной токенизатор HTTP-слоя (`get_tokenizer(server_args.tokenizer_path, tokenizer_mode=..., trust_remote_code=..., revision=..., tokenizer_backend=...)`) и, для мультимодальных моделей, процессор через `get_processor_wrapper`;
- `DetokenizerManager.init_tokenizer` — свой экземпляр для обратного преобразования и вычисления `vocab_size`;
- `Scheduler` — токенизатор для грамматического слоя и служебных нужд;
- `TpWorker` — отдельная ветка (в частности, для draft-модели спекуляции: комментарий в коде подчеркивает, что `tokenizer_path` всегда указывает на целевую модель, а не на draft).

Значение также попадает в ответ `GET /model_info` (`"tokenizer_path": ...`) — самый быстрый способ проверить, что именно загрузилось.

Особый случай: если путь оканчивается на `.json`, `get_tokenizer` уходит в ветку `TiktokenTokenizer` и `--tokenizer-mode`/`--tokenizer-backend` игнорируются.

## Значения и формат

- **Локальный каталог** с `tokenizer.json` / `tokenizer_config.json` — основной случай.
- **HF repo ID** (`org/name`) — тянется через стандартный кеш HuggingFace; `--download-dir` на это **не** влияет (он относится к весам), а `--revision` — влияет.
- **`.json`-файл** — формат tiktoken; загружается специальным классом, backend и mode не применяются.
- **`s3://`, `gs://`, `az://`** — метаданные предварительно скачиваются в `_handle_model_source_paths`.
- Существование пути отдельно не проверяется: ошибка приходит уже из `transformers`.
- Пустая строка — ложное значение, но не `None`; подстановка дефолта ее не поймает, и загрузка упадет с невнятной ошибкой из `transformers`. Не используйте.

## Когда использовать

- Токенизатор лежит отдельно от весов: конвертированный чекпойнт, GGUF-файл (там `--model-path` указывает на файл, а токенизатора рядом может не быть), веса в объектном хранилище с токенизатором в HF-репозитории.
- Нужен исправленный токенизатор (например, с починенным chat template или добавленными спецтокенами), тогда как веса брать из исходного каталога.
- Не задавайте «для симметрии», если токенизатор лежит там же — дефолт делает это сам и без риска опечатки.
- Не подставляйте сюда токенизатор другой модели «потому что архитектура похожая»: ошибка не диагностируется и проявится испорченным выводом.

## Влияние на производительность и память

- **RAM хоста:** экземпляр токенизатора создается в каждом процессе, который его читает. При `--tokenizer-worker-num N` копий станет N (по одной на HTTP-worker) плюс копии в детокенизаторе и планировщике. Для обычного BPE-токенизатора это единицы-десятки мегабайт на копию; для мультимодального процессора с image processor'ом — больше.
- **Время старта:** удаленный путь означает сетевую загрузку до появления HTTP-порта.
- **VRAM:** не затрагивается.
- **Latency:** сам путь ни на что не влияет; влияет то, какой токенизатор загрузился (см. `tokenizer-mode.md` и `tokenizer-backend.md`).

## Взаимодействие с другими аргументами

- `--model-path`: источник значения по умолчанию.
- `--skip-tokenizer-init`: токенизатор не загружается вовсе, путь перестает использоваться (хотя резолв путей в `__post_init__` все равно происходит).
- `--tokenizer-mode`, `--tokenizer-backend`: применяются к загрузке по этому пути, кроме tiktoken-ветки.
- `--revision`: версия, с которой резолвится удаленный путь.
- `--trust-remote-code`: нужен, если токенизатор содержит собственный код.
- `--download-dir`: относится к весам и к ModelScope-кешу; обычный HF-кеш токенизатора он не переопределяет.
- `--served-model-name`: получает такой же дефолт от `--model-path`, но никак не связан с этим аргументом.

## Типовые проблемы и диагностика

- **Симптом:** осмысленный, но неверный текст; модель «путает» спецтокены, шаблон чата не срабатывает. **Причина:** загружен чужой токенизатор. **Проверка:** `curl -s http://127.0.0.1:30000/model_info` и сравнение `tokenizer_path` с каталогом весов; далее сверка `len(tokenizer)` с `vocab_size` из `config.json` модели.
- **Симптом:** `OSError: Can't load tokenizer for '<путь>'`. **Причина:** в каталоге нет файлов токенизатора. **Лечение:** указать каталог с `tokenizer.json`/`tokenizer_config.json`.
- **Симптом:** старт висит без логов. **Причина:** идет скачивание токенизатора с HF. **Лечение:** локальный снапшот.
- **Симптом:** `Processor <путь> does not have a slow version. Automatically use fast version` в логе. **Причина:** `--tokenizer-mode slow` для мультимодальной модели без slow-процессора; это информационное сообщение, а не ошибка.
- **Подтверждение:** `tokenizer_path` виден и в дампе `server_args=`, и в ответе `/model_info`.

## В arriero

Отдельного поля в типизированной конфигурации движка для токенизатора нет — `KTransformersInstanceConfigSchema` (`packages/core/src/instance.ts`) содержит `model`, `cpuWeights`, `method` и `servedModelName`. Ключ `--tokenizer-path` не зарезервирован, поэтому его можно задать в сырых `args` инстанса, если токенизатор действительно лежит отдельно от модели.

Практический контекст: в квалифицированном профиле (`docs/KTRANSFORMERS_OPERATIONS.md`) `--model-path` указывает на обычный каталог SGLang-модели или на HF repo id, а CPU-веса экспертов задаются отдельным `--kt-weight-path`. Токенизатор при этом берется из модели, и `--tokenizer-path` не нужен. Он понадобится только в сценарии, когда основная модель задана каталогом без файлов токенизатора.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tokenizer-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/converted/qwen3-30b-weights --tokenizer-path Qwen/Qwen3-30B-A3B --revision main --host 127.0.0.1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/tokenizer.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/detokenizer_manager.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- arriero: `packages/core/src/instance.ts`, `docs/KTRANSFORMERS_OPERATIONS.md`
