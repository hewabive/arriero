---
schema: 1
primaryName: "--timeout"
title: "--timeout"
summary: "Read/write timeout HTTP-сервера в секундах. Одно значение применяется сразу к чтению и записи ответа."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
presetSupport: "router-managed"
aliases:
  - "-to"
  - "--timeout"
allowedValues: []
env:
  - "LLAMA_ARG_TIMEOUT"
related:
  - "--host"
  - "--port"
  - "--threads-http"
---

# --timeout

## Кратко

`--timeout` записывает одно целое значение в `common_params::timeout_read` и `common_params::timeout_write`. Затем `server_http_context::init()` вызывает `set_read_timeout()` и `set_write_timeout()` у `cpp-httplib`.

## Оригинальная справка llama.cpp

```text
server read/write timeout in seconds (default: 3600)
```

## Паспорт аргумента

- Основное имя: `--timeout`
- Алиас: `-to`
- Значение: целое число секунд
- Переменная окружения: `LLAMA_ARG_TIMEOUT`
- Поля в `common_params`: `timeout_read`, `timeout_write`
- Значение по умолчанию: `3600`
- Этап применения: инициализация HTTP-сервера и proxy в router-режиме

## Что меняет в llama-server

Таймаут ограничивает операции чтения запроса и записи ответа на уровне HTTP. В router-режиме те же значения передаются в `server_http_proxy` для проксирования запроса к дочернему модельному процессу.

Это не то же самое, что лимит генерации. Для ограничения количества токенов используйте параметры запроса или `--predict`; для ограничения времени генерации в API есть request-level параметры вроде `t_max_predict_ms`.

## Значения и формат

Ожидается целое число секунд. Специальные значения в help не описаны; используйте положительные значения. Слишком маленький timeout может обрывать streaming-ответы и длинные prompt eval.

## Когда использовать

Увеличивайте для медленных моделей, больших prompts, long-running streaming и слабых клиентов. Уменьшайте для публичных endpoints, где нужно быстрее освобождать HTTP-потоки от зависших клиентов, но делайте это с запасом относительно реальной latency модели.

## Влияние на производительность и память

На скорость токенов не влияет. Малый timeout может преждевременно закрывать соединения; большой timeout дольше держит HTTP thread и ресурсы соединения при зависшем клиенте.

## Взаимодействие с другими аргументами

- `--threads-http` определяет, сколько HTTP-запросов одновременно обслуживается thread pool.
- `--parallel` задает число слотов инференса; timeout не увеличивает емкость слотов.
- В router-режиме timeout влияет и на внешний запрос, и на прокси-запрос к дочернему серверу.

## INI-пресеты и router-режим

В INI: `timeout = 600` или `to = 600`. Для router-процесса это важный общий параметр proxy; модельные пресеты могут наследовать его, если router не удаляет или не перезаписывает конкретные параметры.

## Типовые проблемы и диагностика

- Streaming обрывается до конца: увеличьте `--timeout` и проверьте reverse proxy timeout.
- В логах `stopping wait for next result due to should_stop condition`: клиент закрыл соединение или сработал timeout/stop condition.
- Большие загрузки файлов или медленные клиенты требуют большего read timeout.

## Примеры

```bash
llama-server --model /models/model.gguf --timeout 1200
llama-server --model /models/model.gguf -to 60
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/server-queue.cpp`
