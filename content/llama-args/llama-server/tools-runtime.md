---
schema: 1
primaryName: "--tools-runtime"
title: "--tools-runtime"
summary: "Выносит выполнение built-in tools из `--tools` за пределы хоста: новый контейнер (`docker:<image>`, `podman:<image>`), уже запущенный (`docker-container:<id>`, `podman-container:<id>`) или удалённый POSIX-хост по SSH (`ssh:<target>`). По умолчанию tools работают на хосте."
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

`--tools-runtime` уводит I/O built-in tools (`--tools`) из файловой системы и shell хоста в отдельную среду: контейнер Docker/Podman или удалённый хост по SSH. Без аргумента tools выполняются в среде процесса `llama-server` — читают его файлы и запускают команды от его имени.

Аргумент экспериментальный и имеет смысл только вместе с непустым `--tools`.

## Оригинальная справка llama.cpp

```text
experimental: run tools in a separate runtime environment (default: none, use host environment)
available options:
  'docker:<image>', 'podman:<image>': spin up a new container and reuse it for all invocations, clean up on server exit
  'docker-container:<id>', 'podman-container:<id>': use an existing container by ID, won't stop on server exit
  'ssh:<target>': run tools on a remote POSIX host over SSH, key-based auth and a trusted host key are required
```

## Паспорт аргумента

- Основное имя: `--tools-runtime`
- Значение: `docker:<image>`, `podman:<image>`, `docker-container:<id>`, `podman-container:<id>` или `ssh:<target>`
- Переменная окружения: `LLAMA_ARG_TOOLS_RUNTIME`
- Поле в `common_params`: `server_tools_runtime`
- Значение по умолчанию: пустая строка — tools работают на хосте
- Требования: CLI выбранного движка (`docker`, `podman`) или `ssh` на хосте; любой вариант значения проверяется на старте

## Что меняет в llama-server

Docker и Podman принимают одни и те же verbs в одном порядке, поэтому обе формы обслуживает одна реализация, а движок выбирается префиксом значения.

- `docker:<image>` / `podman:<image>` — spawned-режим: на старте tools сервер запускает `<engine> run --rm -i --cidfile <tmp> <image> sh`, держит stdin открытым, чтобы контейнер жил, и переиспользует его для всех вызовов tools. ID контейнера читается из cidfile (до 10 секунд ожидания). Если контейнер умирает, сервер пишет warning и пересоздает его; при завершении `llama-server` stdin закрывается, shell выходит, и `--rm` удаляет контейнер.
- `docker-container:<id>` / `podman-container:<id>` — attach-режим: используется уже запущенный контейнер. Лишнего lifecycle у него нет, поэтому spec проверяется один раз на старте, а дальше каждый вызов идёт напрямую в `<engine> exec`. Остановленный контейнер не диагностируется отдельно — наружу выходит ошибка самого движка. Контейнер переживает завершение `llama-server`.
- `ssh:<target>` — удалённый режим: команды выполняются на другом POSIX-хосте через `ssh`. Это remoting, а не изоляция: tools могут всё, что может целевая учётная запись, а изоляцией занимается то, что запускает их на той стороне.

Внутри контейнера команды идут через `<engine> exec`; для SSH argv собирается в одну строку через shell-quoting, потому что удалённый shell разбирает командную строку заново. Отдельного шага копирования файлов больше нет: `write_file` выполняет в изоляте `sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1"'` и передаёт содержимое на stdin, поэтому ни `docker cp`, ни `scp` не нужны и содержимое не попадает в argv. Таймаут одного вызова в изоляте — 15 секунд.

Изолят всегда считается POSIX-средой независимо от ОС хоста: `exec_shell_command` использует `sh -c` даже на Windows-хосте, `get_info` выполняет `uname -a` и `pwd` внутри изолята вместо хостовых вызовов.

Отдельный запрос может переопределить изолят HTTP-заголовком `x-tool-runtime` (например, `docker-container:<id>` или `ssh:<target>`); без заголовка используется значение из `--tools-runtime`. Spawned-форму заголовок принять не может: создавать контейнер разрешено только тому runtime, который им владеет, иначе запрос отклоняется как `tool runtime must name a running container`. Поле `runtime` в JSON body игнорируется — источником служит только заголовок или серверная настройка.

## Значения и формат

- `docker:<image>` / `podman:<image>`: имя образа, например `docker:alpine` или `podman:ubuntu:24.04`. Пустое имя образа — ошибка старта.
- `docker-container:<id>` / `podman-container:<id>`: ID или имя запущенного контейнера. Значение должно начинаться с буквы или цифры и состоять из `A-Za-z0-9`, `.`, `-`, `_`.
- `ssh:<target>`: всё, что понимает сам `ssh` — `user@host` или alias из `~/.ssh/config`. Значение не может начинаться с `-` и состоит из `A-Za-z0-9`, `.`, `-`, `_`, `@`.
- Любой другой префикс: ошибка `unknown tool runtime`.

Ограничения на набор символов не косметические: значение может прийти из клиентского заголовка `x-tool-runtime`, а спец-значение вида `-oProxyCommand=...` или `--privileged` превратилось бы в опцию `ssh`/движка и выполнилось бы на хосте.

## SSH-транспорт

`ssh` вызывается с фиксированным набором опций: `BatchMode=yes`, `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`, `StrictHostKeyChecking=yes`. Консоли у tool call нет, поэтому любой интерактивный запрос просто повесил бы вызов. Практическое следствие: до запуска сервера ключ должен быть разложен (`ssh-copy-id` или agent), а host key целевого хоста — уже находиться в `known_hosts`.

Учётные данные в llama.cpp не хранятся: всё разрешение цели отдано `ssh`, включая alias-ы и `ProxyJump` из клиентского конфига.

## Когда использовать

Включайте всегда, когда `--tools` содержит небезопасные tools (`exec_shell_command`, `write_file`, `edit_file`) и модель/агент может получать недоверенный ввод: изолят не даёт командам и файловым операциям трогать файловую систему хоста. `docker:<image>`/`podman:<image>` удобны как одноразовая чистая среда; attach-форма — когда агенту нужно заранее подготовленное окружение (склонированный репозиторий, установленные пакеты) или состояние, переживающее рестарты сервера. `ssh:<target>` берите, когда работа должна идти на другой машине — например, tools нужны на build-хосте, а модель крутится на GPU-хосте.

Контейнерные формы — это изоляция файловой системы и процессов, а не полный security boundary: контейнер по умолчанию имеет сеть, лимиты CPU/памяти не задаются, а выбранный образ определяет доступный инструментарий. Для жёстких ограничений готовьте контейнер сами и подключайте его через attach-форму. `ssh:<target>` изоляции не даёт вовсе — оценивайте его по правам целевой учётной записи.

## Влияние на производительность и память

На инференс не влияет. Каждый вызов tool превращается в `<engine> exec` или в отдельную `ssh`-сессию, что добавляет накладные расходы порядка десятков-сотен миллисекунд на вызов по сравнению с хостовым запуском; для SSH к этому добавляется сетевой RTT и рукопожатие. Spawned-контейнер живёт всё время работы сервера и потребляет ресурсы как обычный контейнер с `sh`.

## Взаимодействие с другими аргументами

- `--tools`: обязательное условие — без непустого списка tools endpoint `/tools` не регистрируется и runtime не используется.
- `--api-key`: по-прежнему нужен — изолят ограничивает последствия вызова, но не доступ к endpoint.
- `--cors-origins` и `--host`: правила безопасности `--tools` не меняются; непустой список tools всё так же ограничивает CORS до `localhost` по умолчанию.

## INI-пресеты и router-режим

В INI: `tools-runtime = docker:alpine`. В router-режиме изолят принадлежит конкретному процессу `llama-server`, на котором применён аргумент; каждый дочерний процесс с tools получает свой.

## Типовые проблемы и диагностика

- `unknown tool runtime: <spec>`: опечатка в префиксе; допустимы только `docker:`, `podman:`, `docker-container:`, `podman-container:` и `ssh:`.
- `--tools-runtime <engine>:<image> requires an image name`: пустое значение после префикса.
- `invalid container id: <id>` / `invalid ssh target: <target>`: значение пустое, начинается с `-` или содержит символы вне разрешённого набора.
- `tool runtime must name a running container: <spec>`: заголовком `x-tool-runtime` попытались попросить spawned-форму; заголовок принимает только attach-форму или `ssh:`.
- `failed to spawn <engine> container for tools runtime (image: ...)`: CLI движка недоступен, образ не найден или демон не запущен; проверьте `<engine> run <image>` вручную.
- `timed out waiting for <engine> container to start (image: ...)`: контейнер не поднялся за отведённое время — обычно долгий pull образа; скачайте образ заранее.
- Warning `<engine> tools runtime container "..." died, respawning` в логах: spawned-контейнер умер (например, OOM) и был пересоздан; накопленное в нём состояние потеряно.
- Ошибка движка на каждом вызове tool в attach-режиме: контейнер остановлен, сервер его не перезапускает — поднимите его сам (`<engine> start <id>`).
- SSH-вызовы висят или падают сразу: проверьте key-based auth и запись в `known_hosts` — пароль и подтверждение host key запросить некому.
- Tool не видит файлы хоста: это ожидаемое поведение изолята — файлы нужно монтировать в контейнер или готовить на целевом хосте заранее.

## Примеры

```bash
llama-server --model /models/model.gguf --tools all --tools-runtime docker:alpine --api-key local-secret
```

```bash
podman run -d --name agent-env -v /data/repo:/repo ubuntu:24.04 sleep infinity
llama-server --model /models/model.gguf --tools exec_shell_command,read_file --tools-runtime podman-container:agent-env
```

```bash
llama-server --model /models/model.gguf --tools all --tools-runtime ssh:builder@10.0.0.5 --api-key local-secret
```

Per-request переопределение изолята:

```bash
curl -X POST http://127.0.0.1:8080/tools -H "Authorization: Bearer local-secret" \
  -H "x-tool-runtime: docker-container:agent-env" \
  -d '{"tool":"exec_shell_command","params":{"command":"ls /repo"}}'
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--tools-runtime`.
- `llama.cpp/tools/server/server-tools.cpp`: `container_runtime_spec`, `tools_io_container`, `tools_io_ssh`, `server_tools_container_runtime`, обработка `x-tool-runtime`.
- `llama.cpp/tools/server/README.md` и `README-dev.md`.
- https://github.com/ggml-org/llama.cpp/pull/26507: initial tool isolation support (via docker).
- https://github.com/ggml-org/llama.cpp/pull/26774: podman, ssh и отказ от шага копирования файлов.
