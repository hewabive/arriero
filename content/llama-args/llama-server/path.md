---
schema: 1
primaryName: "--path"
title: "--path"
summary: "Каталог статических файлов, которые `llama-server` будет отдавать вместо встроенных UI-ассетов. Применяется только когда Web UI включен."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "PATH"
aliases:
  - "--path"
allowedValues: []
env:
  - "LLAMA_ARG_STATIC_PATH"
related:
  - "--api-prefix"
  - "--ui"
---

# --path

## Кратко

`--path` записывается в `common_params::public_path`. Если `--ui` включен и путь не пустой, `server_http_context::init()` вызывает `set_mount_point(params.api_prefix + "/", params.public_path)` и отдает файлы из этого каталога как статический UI.

## Оригинальная справка llama.cpp

```text
path to serve static files from (default: )
```

## Паспорт аргумента

- Основное имя: `--path`
- Значение: путь к каталогу
- Переменная окружения: `LLAMA_ARG_STATIC_PATH`
- Поле в `common_params`: `public_path`
- Значение по умолчанию: пустая строка
- Этап применения: инициализация HTTP routes

## Что меняет в llama-server

Без `--path` сервер использует встроенные ассеты UI, если бинарник собран с `LLAMA_UI_HAS_ASSETS`. С `--path` каталог монтируется на корень API-префикса. Если каталог не найден, init завершается ошибкой `static assets path not found: ...`.

API routes вроде `/v1/chat/completions` регистрируются отдельно и не становятся файлами из `--path`.

## Значения и формат

Указывайте существующий каталог. Относительные пути считаются относительно текущего рабочего каталога процесса `llama-server`, поэтому для менеджера процессов надежнее абсолютный путь.

## Когда использовать

Используйте для разработки собственной сборки UI, замены статических файлов или запуска бинарника без встроенных ассетов. Для обычного сервера с дефолтным Web UI аргумент не нужен.

## Влияние на производительность и память

На инференс не влияет. Может немного изменить задержку отдачи UI-ассетов, потому что файлы читаются из файловой системы вместо встроенного ресурса.

## Взаимодействие с другими аргументами

- `--ui` / `--no-ui` определяет, будут ли регистрироваться UI routes.
- `--api-prefix` добавляется к mount point, например `--api-prefix /llama --path ./public` монтирует статические файлы под `/llama/`.
- `--api-key` middleware считает несколько стандартных UI-файлов публичными, но при нестандартном префиксе это стоит проверять отдельным запросом.

## INI-пресеты и router-режим

В INI: `path = /srv/llama-ui`. Путь относится к процессу, который отдает внешний HTTP listener. В router-режиме UI отдает router; дочерние модельные процессы обслуживают проксируемые API-запросы.

## Типовые проблемы и диагностика

- `static assets path not found`: путь не существует или пользователь процесса не видит каталог.
- UI открывается, но API 404: проверьте, не конфликтуют ли файлы и `--api-prefix`.
- Относительный путь работает из shell, но ломается в service unit: задайте абсолютный путь или правильный working directory.

## Примеры

```bash
llama-server --model /models/model.gguf --path /srv/llama-ui
llama-server --model /models/model.gguf --api-prefix /llama --path /srv/llama-ui
llama-server --model /models/model.gguf --no-ui
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/README.md`
