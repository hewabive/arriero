---
schema: 1
primaryName: "--port"
title: "--port"
summary: "TCP-порт, на котором `llama-server` принимает HTTP-запросы. Значение `0` просит ОС выбрать свободный порт автоматически."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "PORT"
presetSupport: "router-managed"
aliases:
  - "--port"
allowedValues: []
env:
  - "LLAMA_ARG_PORT"
related:
  - "--api-key"
  - "--api-key-file"
  - "--api-prefix"
  - "--host"
  - "--reuse-port"
  - "--ssl-cert-file"
  - "--ssl-key-file"
  - "--timeout"
---

# --port

## Кратко

`--port` записывается в `common_params::port` и используется при bind HTTP-сервера. По умолчанию это `8080`. Если указать `0`, `server_http_context::start()` вызывает `bind_to_any_port()` и сохраняет фактически выбранный порт в `listening_address`.

## Оригинальная справка llama.cpp

```text
port to listen (default: 8080)
```

## Паспорт аргумента

- Основное имя: `--port`
- Значение: целое число `PORT`
- Переменная окружения: `LLAMA_ARG_PORT`
- Поле в `common_params`: `port`
- Значение по умолчанию: `8080`
- Этап применения: старт HTTP-сервера

## Что меняет в llama-server

Порт применяется до загрузки модели: сервер стартует HTTP listener, затем отвечает `/health` состоянием загрузки, и только потом загружает модель. В режиме Google Cloud Vertex AI (`AIP_MODE=PREDICTION`) порт может быть перезаписан переменной `AIP_HTTP_PORT`; в лог попадает предупреждение об override.

Если `--host` заканчивается на `.sock`, сетевой порт не используется.

## Значения и формат

Ожидается целое число. Парсер `common_arg` записывает его как `int`; проверка диапазона порта в обработчике аргумента не выполняется. Практически используйте диапазон `1..65535` или `0` для автоматического выбора. Некорректный или занятый порт проявляется ошибкой bind.

## Когда использовать

Меняйте `--port`, когда на `8080` уже есть сервис, когда запускаете несколько экземпляров или когда порт должен совпасть с настройками reverse proxy, Docker mapping или health checks.

## Влияние на производительность и память

На скорость инференса и память не влияет. При нескольких серверах на одной машине порт определяет только точку входа; конкуренция за CPU/GPU возникает уже из-за параллельных процессов и запросов.

## Взаимодействие с другими аргументами

- `--host` задает адрес, вместе с которым порт образует bind endpoint.
- `--reuse-port` позволяет нескольким сокетам привязаться к одному адресу/порту, если ОС поддерживает `SO_REUSEPORT`.
- `--api-key`, `--api-key-file`, `--ssl-key-file`, `--ssl-cert-file` важны при доступе не только с localhost.
- `--timeout` задает read/write timeout для соединений на этом listener.

## INI-пресеты и router-режим

В INI ключ пишется как `port = 8080` или `LLAMA_ARG_PORT = 8080`. В router-режиме внешний `--port` принадлежит router-процессу. Дочерние модельные процессы получают автоматически выбранные свободные порты и `LLAMA_ARG_HOST = 127.0.0.1`; значение из модельного пресета для `port` перезаписывается.

## Типовые проблемы и диагностика

- `couldn't bind HTTP server socket`: порт занят, запрещен политикой ОС или указан неверный `--host`.
- При `--port 0` заранее неизвестен URL; смотрите строку `server is listening on ...`.
- В контейнере нужно различать порт внутри контейнера (`--port`) и публикацию наружу (`docker run -p host:container`).

## Примеры

```bash
llama-server --model /models/model.gguf --port 8081
llama-server --model /models/model.gguf --host 0.0.0.0 --port 8080
llama-server --model /models/model.gguf --port 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
