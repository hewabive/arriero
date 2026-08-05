---
schema: 1
primaryName: "--host"
title: "--host"
summary: "Адрес, на котором `llama-server` слушает HTTP API. Значение с суффиксом `.sock` переключает сервер на UNIX domain socket вместо TCP."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "HOST"
presetSupport: "router-managed"
aliases:
  - "--host"
allowedValues: []
env:
  - "LLAMA_ARG_HOST"
related:
  - "--api-key"
  - "--api-key-file"
  - "--api-prefix"
  - "--port"
  - "--reuse-port"
  - "--ssl-cert-file"
  - "--ssl-key-file"
  - "--timeout"
---

# --host

## Кратко

`--host` записывается в `common_params::hostname` и используется только при привязке HTTP-сокета. По умолчанию сервер слушает `127.0.0.1`, то есть доступен с локальной машины; для контейнера или LAN обычно указывают `0.0.0.0`, но тогда обязательно нужны внешние ограничения доступа.

Если строка заканчивается на `.sock`, `server_http_context::start()` включает `AF_UNIX` и вызывает `bind_to_port(hostname, 8080)`, где порт фактически не является сетевым портом.

## Оригинальная справка llama.cpp

```text
ip address to listen, or bind to an UNIX socket if the address ends with .sock (default: 127.0.0.1)
```

## Паспорт аргумента

- Основное имя: `--host`
- Алиасы: `--host`
- Значение: строка `HOST`
- Переменная окружения: `LLAMA_ARG_HOST`
- Поле в `common_params`: `hostname`
- Значение по умолчанию: `127.0.0.1`
- Этап применения: старт HTTP-сервера, до загрузки модели

## Что меняет в llama-server

В TCP-режиме `llama-server` привязывает `cpp-httplib` к указанному адресу и к `--port`. При `--port 0` порт выбирается системой, но адрес все равно берется из `--host`. При UNIX-сокете адрес в логах становится `unix://<path>`.

Флаг не меняет маршруты API, модель, KV-cache или параметры генерации. Он влияет на то, кто может подключиться к серверу.

## Значения и формат

- `127.0.0.1`: безопасный локальный режим по умолчанию.
- `0.0.0.0`: слушать все IPv4-интерфейсы; типично для Docker с `-p`.
- `::1` или другой IPv6-адрес: зависит от поддержки `cpp-httplib` и ОС.
- `/run/llama-server.sock`: UNIX socket, потому что строка заканчивается на `.sock`.

`--host` не валидирует IP-адрес в парсере. Ошибка обнаруживается при bind и выглядит как `couldn't bind HTTP server socket, hostname: ..., port: ...`.

## Когда использовать

Используйте `127.0.0.1`, если к серверу обращается только локальный клиент или reverse proxy на той же машине. Используйте `0.0.0.0` только в контролируемой сети, за firewall/reverse proxy и с `--api-key` или `--api-key-file`. UNIX socket удобен для локального reverse proxy, когда TCP-порт не нужен.

## Влияние на производительность и память

На инференс, RAM, VRAM и KV-cache не влияет. Непрямой эффект возможен только через доступность: публичная привязка увеличивает число потенциальных клиентов и может загрузить HTTP thread pool и слоты.

## Взаимодействие с другими аргументами

- `--port` задает TCP-порт; при `.sock` он не используется как сетевой порт.
- `--reuse-port` добавляет `SO_REUSEPORT` только в TCP/сокетной настройке.
- `--api-key` и `--api-key-file` нужны при любом небезопасном bind address.
- `--ssl-key-file` и `--ssl-cert-file` включают HTTPS, но не заменяют аутентификацию.
- `--api-prefix` меняет URL-префикс маршрутов, но не адрес bind.

## INI-пресеты и router-режим

В INI ключ пишется как `host = 127.0.0.1` или `LLAMA_ARG_HOST = 127.0.0.1`. В router-режиме дочерним модельным процессам router принудительно задает `LLAMA_ARG_HOST = 127.0.0.1`, чтобы они не слушали внешний интерфейс; внешний адрес задается у процесса-router.

## Типовые проблемы и диагностика

- `couldn't bind HTTP server socket`: адрес не существует на машине, порт занят или нет прав на путь socket-файла.
- Сервер доступен локально, но не из контейнера: проверьте `--host 0.0.0.0` внутри контейнера и публикацию порта Docker.
- При публичном адресе запросы без ключа проходят к `/health`, `/models` и статическим UI-файлам, если они считаются public endpoints. Остальные API требуют ключ только если он настроен.

## Примеры

```bash
llama-server --model /models/model.gguf --host 127.0.0.1 --port 8080
llama-server --model /models/model.gguf --host 0.0.0.0 --port 8080 --api-key change-me
llama-server --model /models/model.gguf --host /run/llama-server.sock
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
