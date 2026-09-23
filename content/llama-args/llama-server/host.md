---
schema: 1
primaryName: "--host"
title: "--host"
summary: "Список адресов, на которых `llama-server` слушает HTTP API. Можно указать несколько TCP-адресов или путей UNIX-сокетов с суффиксом `.sock` через запятую."
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

`--host` записывает список адресов в `common_params::hostnames`. По умолчанию сервер слушает `127.0.0.1`, то есть доступен с локальной машины; для контейнера или LAN обычно указывают `0.0.0.0`, но тогда обязательно нужны внешние ограничения доступа.

Адреса разделяются запятыми. Для каждого элемента с суффиксом `.sock` сервер создаёт UNIX-сокет; остальные элементы становятся отдельными TCP-listener-ами.

## Оригинальная справка llama.cpp

```text
IP addresses to listen on, comma-separated, or UNIX socket paths ending in .sock; with multiple TCP addresses, :: binds IPv6 only; overlapping addresses result in undefined behavior (default: 127.0.0.1)
```

## Паспорт аргумента

- Основное имя: `--host`
- Алиасы: `--host`
- Значение: один или несколько адресов через запятую
- Переменная окружения: `LLAMA_ARG_HOST`
- Поле в `common_params`: `hostnames`
- Значение по умолчанию: `127.0.0.1`
- Этап применения: старт HTTP-сервера, до загрузки модели

## Что меняет в llama-server

`llama-server` создаёт отдельный listener для каждого адреса. TCP-адреса используют общий `--port`; `--port 0` допускается только с одним TCP-адресом. Для UNIX-сокета `--port` не используется, а адрес в логах отображается как `unix://<path>`.

Флаг не меняет маршруты API, модель, KV-cache или параметры генерации. Он влияет на то, кто может подключиться к серверу.

## Значения и формат

- `127.0.0.1`: безопасный локальный режим по умолчанию.
- `0.0.0.0`: слушать все IPv4-интерфейсы; типично для Docker с `-p`.
- `::1` или другой IPv6-адрес: зависит от поддержки `cpp-httplib` и ОС.
- `/run/llama-server.sock`: UNIX socket, потому что строка заканчивается на `.sock`.
- `127.0.0.1,::1`: два локальных TCP-listener-а. При нескольких TCP-адресах `::` привязывается только к IPv6.

Парсер разделяет CSV-строку и убирает пробелы вокруг адресов; пустые элементы пропускает, а полностью пустой список отклоняет. Перекрывающиеся адреса, например `0.0.0.0` вместе с конкретным IPv4-адресом, дают неопределённое поведение. Ошибка bind выглядит как `couldn't bind HTTP server socket, hostname: ..., port: ...`.

## Когда использовать

Используйте `127.0.0.1`, если к серверу обращается только локальный клиент или reverse proxy на той же машине. Используйте `0.0.0.0` только в контролируемой сети, за firewall/reverse proxy и с `--api-key` или `--api-key-file`. UNIX socket удобен для локального reverse proxy, когда TCP-порт не нужен.

## Влияние на производительность и память

На инференс, RAM, VRAM и KV-cache не влияет. Непрямой эффект возможен только через доступность: публичная привязка увеличивает число потенциальных клиентов и может загрузить HTTP thread pool и слоты.

## Взаимодействие с другими аргументами

- `--port` задает TCP-порт; при `.sock` он не используется как сетевой порт.
- `--port 0` несовместим с несколькими TCP-адресами.
- `--reuse-port` добавляет `SO_REUSEPORT` только в TCP/сокетной настройке.
- `--api-key` и `--api-key-file` нужны при любом небезопасном bind address.
- `--ssl-key-file` и `--ssl-cert-file` включают HTTPS, но не заменяют аутентификацию.
- `--api-prefix` меняет URL-префикс маршрутов, но не адрес bind.

## INI-пресеты и router-режим

В INI ключ пишется как `host = 127.0.0.1` или `LLAMA_ARG_HOST = 127.0.0.1`. В router-режиме дочерним модельным процессам router принудительно задает `LLAMA_ARG_HOST = 127.0.0.1`, чтобы они не слушали внешний интерфейс; внешний адрес задается у процесса-router.

## Типовые проблемы и диагностика

- `couldn't bind HTTP server socket`: адрес не существует на машине, порт занят или нет прав на путь socket-файла.
- `--port 0 is not supported with multiple TCP addresses`: задайте фиксированный TCP-порт или оставьте один TCP-адрес.
- Сервер доступен локально, но не из контейнера: проверьте `--host 0.0.0.0` внутри контейнера и публикацию порта Docker.
- При публичном адресе запросы без ключа проходят к `/health`, `/models` и статическим UI-файлам, если они считаются public endpoints. Остальные API требуют ключ только если он настроен.

## Примеры

```bash
llama-server --model /models/model.gguf --host 127.0.0.1 --port 8080
llama-server --model /models/model.gguf --host 0.0.0.0 --port 8080 --api-key change-me
llama-server --model /models/model.gguf --host /run/llama-server.sock
llama-server --model /models/model.gguf --host 127.0.0.1,::1 --port 8080
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
