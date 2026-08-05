---
schema: 1
primaryName: "--model-url"
title: "--model-url"
summary: "Скачивает основной GGUF по прямому URL и затем запускает сервер с локальной копией. Для URL используется ETag-кэш, а `--offline` разрешает только уже имеющийся файл."
category: "Общие параметры"
valueType: "string"
estimation: "remote-selector"
valueHint: "MODEL_URL"
aliases:
  - "-mu"
  - "--model-url"
allowedValues: []
env:
  - "LLAMA_ARG_MODEL_URL"
related:
  - "--model"
  - "--hf-repo"
  - "--hf-token"
  - "--offline"
  - "--cache-list"
---

# --model-url

## Кратко

`--model-url` задает прямой URL для скачивания основного файла модели. Значение записывается в `common_params.model.url`, затем `common_params_handle_model()` скачивает файл через общий downloader и подставляет локальный путь в `model.path`.

Это не Hugging Face selector. Для HF-репозиториев лучше использовать `--hf-repo`, потому что он понимает список файлов репозитория, quant tag, split GGUF и автоматический поиск `mmproj`.

## Оригинальная справка llama.cpp

```text
model download url (default: unused)
```

## Паспорт аргумента

- Основное имя: `--model-url`
- Алиасы: `-mu`, `--model-url`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `MODEL_URL`
- Переменные окружения: `LLAMA_ARG_MODEL_URL`
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.model.url`

## Что меняет в llama-server

Если `model.url` не пустой и `model.path` пустой, llama.cpp вычисляет путь в кэше из URL: удаляет `#fragment` и query string, берет последний сегмент пути и передает его в `fs_get_cache_file()`. Если `--model` тоже задан, скачивание идет в указанный `--model` путь.

Downloader использует `common_download_file_single()`:

- в online-режиме делает HTTP-запрос, поддерживает докачку через `Range`, временный файл `.downloadInProgress` и ETag;
- при успешном скачивании возвращает локальный `model.path`;
- при ошибке выбрасывается `failed to download model from <url>`.

## Значения и формат

Ожидается URL, по которому доступен один файл модели. Файл должен быть GGUF, пригодным для загрузки как основной `llama_model`.

Для URL-источников не выполняется HF-планирование: `--model-url` не выбирает quant по имени, не ищет соседние файлы в репозитории и не подбирает `mmproj`. Для split GGUF прямой URL удобен только если вы явно управляете локальным путем и соседними shard-файлами.

## Когда использовать

Используйте `--model-url`, когда модель опубликована как один прямой артефакт вне Hugging Face API или когда нужен простой bootstrap в локальный cache. Для приватных HF-репозиториев, токена и выбора файла используйте `--hf-repo`, `--hf-file` и `--hf-token`.

## Влияние на производительность и память

На время первого старта влияет сеть, размер файла, скорость диска и возможность продолжить `.downloadInProgress`. После скачивания сервер работает как с обычным локальным `--model`; RAM/VRAM зависят от самой модели.

В online-режиме ETag позволяет избежать повторной загрузки неизмененного файла. В offline-режиме сетевых запросов нет: файл должен уже существовать по рассчитанному или заданному локальному пути.

## Взаимодействие с другими аргументами

- `--model`: задает локальный путь назначения для скачивания; без него путь берется из cache directory и имени URL.
- `--offline`: запрещает сеть и требует существующий локальный файл.
- `--hf-token`: токен передается в `common_download_opts.bearer_token`, но для произвольного URL это полезно только если сервер принимает Bearer auth.
- `--mmproj-url`: отдельный URL для projector; `--model-url` сам его не находит.
- `--cache-list`: показывает HF cache-модели, но не является полным индексом всех ETag URL-файлов.

## INI-пресеты и router-режим

В INI ключ пишется как `model-url = https://...`. Если нужно закрепить путь назначения, добавьте `model = /abs/path/model.gguf`.

Router README описывает cache, `--models-dir` и `--models-preset` как основные источники моделей. Прямой `model-url` в пресете может потребовать сетевой доступ при загрузке дочернего процесса; для production-router обычно надежнее заранее подготовить локальный `model`.

## Типовые проблемы и диагностика

- `download received non-successful status code`: URL недоступен, требует другой auth или отдает не файл.
- `failed to download model from <url>`: скачивание не завершилось или файл не появился в cache.
- `required file is not available in cache (offline mode)`: включен `--offline`, но локальная копия отсутствует.
- Сервер скачал файл с неожиданным именем: укажите `--model /abs/path/file.gguf` вместе с `--model-url`.

## Примеры

```bash
llama-server --model-url https://example.org/models/TinyLlama-Q4_K_M.gguf
```

```bash
llama-server --model /srv/models/TinyLlama-Q4_K_M.gguf --model-url https://example.org/download?id=123
```

```ini
[remote_single_file]
model = /srv/models/model.gguf
model-url = https://example.org/releases/model.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
- `llama.cpp/tools/server/README.md`
