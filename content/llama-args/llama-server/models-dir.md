---
schema: 1
primaryName: "--models-dir"
title: "--models-dir"
summary: "Добавляет каталог локальных GGUF-моделей в каталог router-режима. Сервер сканирует каталог на старте и при reload списка моделей."
category: "Параметры llama-server"
valueType: "path"
estimation: "router"
valueHint: "PATH"
presetSupport: "router-managed"
aliases:
  - "--models-dir"
allowedValues: []
env:
  - "LLAMA_ARG_MODELS_DIR"
related:
  - "--model"
  - "--mmproj"
  - "--models-preset"
  - "--models-max"
  - "--models-autoload"
  - "--alias"
  - "--tags"
---

# --models-dir

## Кратко

`--models-dir` включает источник локальных моделей для router-режима `llama-server`. Это не путь к одной модели, а каталог, из которого router строит набор модельных пресетов.

Router-режим запускается, когда `llama-server` стартует без обычной модели `--model`/`-hf`. В этом режиме основной процесс хранит каталог доступных моделей, запускает дочерние `llama-server` для выбранной модели и проксирует запросы по имени модели.

## Оригинальная справка llama.cpp

```text
directory containing models for the router server (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--models-dir`
- Алиасы: `--models-dir`
- Тип: `PATH`
- Переменная окружения: `LLAMA_ARG_MODELS_DIR`
- Значение по умолчанию: пустая строка, источник локального каталога отключен
- Поле `common_params`: `models_dir`
- Этап применения: парсинг CLI/env, затем загрузка списка моделей router-процессом
- Router-only: да, в одиночном сервере с явно заданной моделью практического эффекта нет

## Что меняет в llama-server

При старте router вызывает `common_preset_context::load_from_models_dir(params.models_dir)`. Функция проверяет, что путь существует и является каталогом; иначе старт завершается ошибкой вида `does not exist or is not a directory`.

Сканирование превращает найденные GGUF-файлы в пресеты:

- GGUF-файл непосредственно в корне каталога становится моделью с именем файла без `.gguf`.
- Подкаталог становится одной моделью с именем подкаталога.
- В подкаталоге файл с `mmproj` в имени записывается как `--mmproj`.
- Для multi-shard модели выбирается файл с `-00001-of-` в имени.
- Если в подкаталоге нет основного `.gguf`, такой подкаталог не добавляется.

После сканирования эти локальные пресеты объединяются с моделями из cache и с `--models-preset`.

## Значения и формат

Значение должно быть путем к каталогу. Относительные пути разрешены, но считаются относительно текущего рабочего каталога процесса `llama-server`; для управляемых инстансов надежнее использовать абсолютные пути.

Поддерживаемая структура:

```text
models/
  llama-3.2-1b-Q4_K_M.gguf
  qwen3-8b-Q4_K_M.gguf
  gemma-3-4b-it-Q8_0/
    gemma-3-4b-it-Q8_0.gguf
    mmproj-F16.gguf
  Kimi-K2-Thinking-UD-IQ1_S/
    Kimi-K2-Thinking-UD-IQ1_S-00001-of-00006.gguf
    Kimi-K2-Thinking-UD-IQ1_S-00002-of-00006.gguf
```

## Когда использовать

Используйте `--models-dir`, когда модели уже лежат на диске и их не нужно скачивать через Hugging Face cache. Это удобный режим для offline-серверов, заранее подготовленных каталогов с quantized GGUF и multimodal моделей с локальным `mmproj`.

Не используйте его как замену `--model`: если нужен один постоянный сервер для одной модели, проще запустить `llama-server --model /path/model.gguf`.

## Влияние на производительность и память

Сканирование каталога почти не влияет на RAM/VRAM: оно создает пресеты, но не загружает веса. Память начинает расходоваться при фактической загрузке модели: автоматически при запросе, через `POST /models/load`, или через `load-on-startup` в `--models-preset`.

Количество одновременно загруженных дочерних серверов ограничивает `--models-max`. При достижении лимита router выгружает least-recently-used модель, если это разрешено лимитом.

## Взаимодействие с другими аргументами

`--models-preset` может переопределить или дополнить модель из `--models-dir`, если секция INI имеет то же имя. Например, можно добавить `--alias`, `--tags`, `--ctx-size`, `--n-gpu-layers` или `load-on-startup` для модели, найденной в каталоге.

Приоритет источников в router:

1. CLI/env аргументы router-процесса, кроме зарезервированных для дочернего процесса.
2. Модельная секция из `--models-preset`.
3. Глобальная секция `[*]` из `--models-preset`.
4. Автоматические пресеты из `--models-dir` и cache.

Зарезервированные router-аргументы, включая `--models-dir`, `--models-preset`, `--models-max` и `--models-autoload`, удаляются из пресета перед запуском дочернего сервера.

## INI-пресеты и router-режим

Имя модели из `--models-dir` можно использовать как имя секции в INI:

```ini
[*]
ctx-size = 8192
n-gpu-layers = 99

[gemma-3-4b-it-Q8_0]
alias = gemma-vision
tags = vision,local
load-on-startup = true
```

Если секция с таким именем существует, параметры из нее сливаются с автоматически созданным пресетом локальной модели.

## Типовые проблемы и диагностика

- `does not exist or is not a directory`: путь неверен или пользователь процесса не имеет доступа к каталогу.
- Модель не появляется в `/models`: проверьте расширение `.gguf`, имя multi-shard файла `-00001-of-`, наличие основного GGUF в подкаталоге и выполните `GET /models?reload=1`.
- Multimodal модель появилась как text-only: имя файла projection должно содержать `mmproj`, а файл должен лежать в том же подкаталоге.
- Запрос возвращает `model '...' not found`: используйте точный `id` из `/models` или задайте `--alias` через `--models-preset`.

Полезные строки логов: `Loaded N local model presets from ...`, `Available models`, `spawning server instance with name=...`.

## Примеры

```bash
llama-server --models-dir /srv/llama/models
```

```bash
llama-server --models-dir /srv/llama/models --models-preset /srv/llama/models.ini --models-max 2
```

```bash
curl http://127.0.0.1:8080/models
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--models-dir`, env `LLAMA_ARG_MODELS_DIR`.
- `llama.cpp/common/preset.cpp`: `load_from_models_dir`, правила имен, `mmproj`, multi-shard.
- `llama.cpp/tools/server/server-models.cpp`: объединение источников, reload и запуск дочерних серверов.
- `llama.cpp/tools/server/README.md`: раздел `Using multiple models`.
