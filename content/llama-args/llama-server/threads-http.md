---
schema: 1
primaryName: "--threads-http"
title: "--threads-http"
summary: "Задает число fixed worker threads HTTP-сервера cpp-httplib. При `N < 1` сервер выбирает `max(--parallel + 4, hardware_concurrency() - 1)` и пишет фактическое значение в лог."
category: "Параметры llama-server"
valueType: "number"
valueHint: "N"
presetSupport: "router-managed"
aliases:
allowedValues: []
env:
  - "LLAMA_ARG_THREADS_HTTP"
related:
  - "--threads"
  - "--threads-batch"
  - "--parallel"
  - "--timeout"
  - "--metrics"
  - "--slots"
  - "--api-key"
  - "--port"
---

# --threads-http

## Кратко

`--threads-http` управляет только HTTP worker pool: parsing JSON, chat template application, tokenization, сборка JSON-ответов, streaming bookkeeping и обработка служебных endpoints. Он не задает CPU-потоки libllama для inference.

## Оригинальная справка llama.cpp

```text
number of threads used to process HTTP requests (default: -1)
```

## Паспорт аргумента

- Основное имя: `--threads-http`
- Алиасы: `--threads-http`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_THREADS_HTTP`
- Значение по умолчанию: `-1`

## Что меняет в llama-server

Обработчик CLI записывает значение в `params.n_threads_http`. В `server-http.cpp` перед запуском cpp-httplib сервер вычисляет фактическое число потоков: если `params.n_threads_http < 1`, используется `max(params.n_parallel + 4, hardware_concurrency() - 1)`. Затем создается `httplib::ThreadPool(n_threads_http, n_threads_http + 1024)`.

## Значения и формат

`N` - целое число. Положительное значение фиксирует количество постоянно живущих HTTP worker threads. `0`, `-1` и любые значения меньше `1` включают автоматический выбор. В логе запуска ищите строку `using N threads for HTTP server`.

## Когда использовать

Увеличивайте значение, если сервер одновременно принимает много streaming-клиентов, тяжелые chat templates, большие JSON payloads, `/metrics`, `/slots` или proxy/router запросы. Уменьшайте значение на маленьких машинах, где HTTP workers начинают конкурировать с `--threads` и `--threads-batch`.

## Влияние на производительность и память

Каждый fixed HTTP worker потребляет stack и scheduler overhead, но не увеличивает модель, KV-cache или VRAM. Слишком маленькое значение создает очередь HTTP-обработки вокруг tokenization/serialization; слишком большое увеличивает CPU contention и может ухудшить latency inference.

## Взаимодействие с другими аргументами

- `--parallel` участвует в автоматической формуле как `--parallel + 4`.
- `--threads` и `--threads-batch` используют CPU для вычислений; HTTP workers используют те же системные CPU для I/O, parsing и tokenization.
- `--timeout` ограничивает read/write ожидания, но не заменяет достаточный HTTP worker pool.
- `--metrics`, `--slots`, UI и streaming endpoints добавляют HTTP-работу даже без увеличения inference-потоков.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `threads-http = 8`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если новые HTTP-запросы ждут при свободных inference slots, проверьте `using N threads for HTTP server` и увеличьте `--threads-http`.
- Если decode latency выросла после увеличения `--threads-http`, уменьшите HTTP pool или ограничьте inference affinity через `--cpu-mask`/`--cpu-range`.
- В router-режиме параметр применим и к родительскому router server, и к дочерним процессам, если указан в соответствующем пресете.

## Примеры

```bash
llama-server --model /models/model.gguf --threads-http 8
```

```bash
llama-server --model /models/model.gguf --parallel 4 --threads-http 12
```

```ini
[*]
threads-http = 8
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--threads-http` и поле `params.n_threads_http`.
- `llama.cpp/common/common.h` - значение по умолчанию `n_threads_http = -1`.
- `llama.cpp/tools/server/server-http.cpp` - автоматическая формула и создание `httplib::ThreadPool`.
- `llama.cpp/tools/server/README-dev.md` - перечень операций, выполняемых в HTTP worker threads.
