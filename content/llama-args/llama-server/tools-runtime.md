---
schema: 1
primaryName: "--tools-runtime"
title: "--tools-runtime"
summary: "Выносит выполнение built-in tools из `--tools` в отдельную Docker-среду: новый контейнер (`docker:<image>`) или уже запущенный (`docker-container:<id>`). По умолчанию tools работают на хосте."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "OPTION"
aliases:
  - "--tools-runtime"
allowedValues: []
env:
  - "LLAMA_ARG_TOOLS_RUNTIME"
related:
  - "--tools"
  - "--api-key"
  - "--cors-origins"
  - "--host"
---

# --tools-runtime

## Кратко

`--tools-runtime` изолирует I/O built-in tools (`--tools`) от файловой системы и shell хоста, направляя его в Docker-контейнер. Без аргумента tools выполняются в среде процесса `llama-server` — читают его файлы и запускают команды от его имени.

Аргумент экспериментальный и имеет смысл только вместе с непустым `--tools`.

## Оригинальная справка llama.cpp

```text
experimental: run tools in a separate runtime environment (default: none, use host environment)
available options:
  'docker:<image>': spin up a new Docker container and reuse it for all invocations, clean up on server exit
  'docker-container:<id>': use an existing Docker container by ID, won't stop on server exit
```

## Паспорт аргумента

- Основное имя: `--tools-runtime`
- Значение: `docker:<image>` или `docker-container:<id>`
- Переменная окружения: `LLAMA_ARG_TOOLS_RUNTIME`
- Поле в `common_params`: `server_tools_runtime`
- Значение по умолчанию: пустая строка — tools работают на хосте
- Требования: работающий Docker CLI на хосте; неизвестный вариант отклоняется на старте (`unknown --tools-runtime option`)

## Что меняет в llama-server

- `docker:<image>` — spawned-режим: на старте tools сервер запускает `docker run --rm -i <image> sh`, держит stdin открытым, чтобы контейнер жил, и переиспользует его для всех вызовов tools. Если контейнер умирает, сервер пишет warning и пересоздает его; при завершении `llama-server` контейнер удаляется (`--rm`).
- `docker-container:<id>` — existing-режим: используется уже запущенный контейнер по ID. Перед вызовом сервер проверяет `docker inspect -f {{.State.Running}}`; остановленный контейнер дает ошибку `docker container "<id>" is no longer running, restart it to keep using tools` — сервер его не перезапускает. Контейнер переживает завершение `llama-server`.

Внутри изолята команды идут через `docker exec`, передача файлов — через `docker cp`. Изолят всегда считается POSIX-средой независимо от ОС хоста: `exec_shell_command` использует `sh -c` даже на Windows-хосте, `get_info` выполняет `uname -a` и `pwd` внутри контейнера вместо хостовых вызовов.

Отдельный запрос может переопределить изолят HTTP-заголовком `x-tool-runtime` (например, `docker-container:<id>`); без заголовка используется контейнер из `--tools-runtime`. Поле `runtime` в JSON body игнорируется — источником служит только заголовок или серверная настройка.

## Значения и формат

- `docker:<image>`: имя образа, например `docker:alpine` или `docker:ubuntu:24.04`. Пустое имя образа — ошибка старта.
- `docker-container:<id>`: ID или имя запущенного контейнера. Пустой ID — ошибка старта.
- Любой другой префикс: ошибка `unknown --tools-runtime option`.

## Когда использовать

Включайте всегда, когда `--tools` содержит небезопасные tools (`exec_shell_command`, `write_file`, `edit_file`) и модель/агент может получать недоверенный ввод: изолят не дает командам и файловым операциям трогать файловую систему хоста. `docker:<image>` удобен как одноразовая чистая среда; `docker-container:<id>` — когда агенту нужно заранее подготовленное окружение (склонированный репозиторий, установленные пакеты) или состояние, переживающее рестарты сервера.

Это изоляция файловой системы и процессов, а не полный security boundary: контейнер по умолчанию имеет сеть, лимиты CPU/памяти не задаются, а выбранный образ определяет доступный инструментарий. Для жестких ограничений готовьте контейнер сами и подключайте его через `docker-container:<id>`.

## Влияние на производительность и память

На инференс не влияет. Каждый вызов tool превращается в `docker exec`/`docker cp`, что добавляет накладные расходы порядка десятков-сотен миллисекунд на вызов по сравнению с хостовым запуском. Spawned-контейнер живет все время работы сервера и потребляет ресурсы как обычный контейнер с `sh`.

## Взаимодействие с другими аргументами

- `--tools`: обязательное условие — без непустого списка tools endpoint `/tools` не регистрируется и runtime не используется.
- `--api-key`: по-прежнему нужен — изолят ограничивает последствия вызова, но не доступ к endpoint.
- `--cors-origins` и `--host`: правила безопасности `--tools` не меняются; непустой список tools все так же ограничивает CORS до `localhost` по умолчанию.

## INI-пресеты и router-режим

В INI: `tools-runtime = docker:alpine`. В router-режиме контейнер принадлежит конкретному процессу `llama-server`, на котором применен аргумент; каждый дочерний процесс с tools получает свой изолят.

## Типовые проблемы и диагностика

- `unknown --tools-runtime option`: опечатка в префиксе; допустимы только `docker:` и `docker-container:`.
- `--tools-runtime docker:<image> requires an image name` / `docker-container:<id> requires a container id`: пустое значение после префикса.
- `failed to spawn docker container for tools runtime`: Docker CLI недоступен, образ не найден или демон не запущен; проверьте `docker run <image>` вручную.
- `timed out waiting for docker container to start`: контейнер не поднялся за отведенное время — обычно долгий pull образа; скачайте образ заранее.
- `docker container "<id>" is no longer running, restart it to keep using tools`: existing-контейнер остановлен; перезапустите его (`docker start <id>`).
- Warning `docker tools runtime container ... died, respawning` в логах: spawned-контейнер умер (например, OOM) и был пересоздан; накопленное в нем состояние потеряно.
- Tool не видит файлы хоста: это ожидаемое поведение изолята — файлы нужно монтировать в контейнер или копировать заранее.

## Примеры

```bash
llama-server --model /models/model.gguf --tools all --tools-runtime docker:alpine --api-key local-secret
```

```bash
docker run -d --name agent-env -v /data/repo:/repo ubuntu:24.04 sleep infinity
llama-server --model /models/model.gguf --tools exec_shell_command,read_file --tools-runtime docker-container:agent-env
```

Per-request переопределение изолята:

```bash
curl -X POST http://127.0.0.1:8080/tools -H "Authorization: Bearer local-secret" \
  -H "x-tool-runtime: docker-container:agent-env" \
  -d '{"tool":"exec_shell_command","params":{"command":"ls /repo"}}'
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--tools-runtime`.
- `llama.cpp/tools/server/server-tools.cpp`: `server_tools_docker_runtime`, `tools_io_docker`, обработка `x-tool-runtime`.
- `llama.cpp/tools/server/README.md` и `README-dev.md`.
- https://github.com/ggml-org/llama.cpp/pull/26507: initial tool isolation support (via docker).
