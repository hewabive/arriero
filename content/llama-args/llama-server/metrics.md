---
schema: 1
primaryName: "--metrics"
title: "--metrics"
summary: "Включает `GET /metrics` в формате Prometheus text exposition. Без флага endpoint возвращает not supported."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
presetSupport: "router-managed"
aliases:
  - "--metrics"
allowedValues: []
env:
  - "LLAMA_ARG_ENDPOINT_METRICS"
related:
  - "--api-key"
  - "--host"
  - "--port"
  - "--slots"
  - "--threads-http"
---

# --metrics

## Кратко

`--metrics` устанавливает `common_params::endpoint_metrics = true`. Маршрут `/metrics` регистрируется всегда, но без флага обработчик отвечает ошибкой `This server does not support metrics endpoint. Start it with --metrics`.

## Оригинальная справка llama.cpp

```text
enable prometheus compatible metrics endpoint (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--metrics`
- Тип: флаг без значения
- Переменная окружения: `LLAMA_ARG_ENDPOINT_METRICS`
- Поле в `common_params`: `endpoint_metrics`
- Значение по умолчанию: disabled
- Endpoint: `GET /metrics`

## Что меняет в llama-server

При запросе обработчик ставит high-priority задачу `SERVER_TASK_TYPE_METRICS`, получает состояние очереди и слотов, затем отдает `text/plain; version=0.0.4`. Заголовок `Process-Start-Time-Unix` содержит время старта процесса.

Метрики включают counters и gauges: prompt tokens/seconds, predicted tokens/seconds, processing/deferred requests, `n_decode_total`, `n_tokens_max`, `n_busy_slots_per_decode`.

## Значения и формат

Флаг не принимает значение и не имеет `--no-metrics`. В INI falsey-значение просто не выведет флаг, потому что отрицательного варианта нет.

## Когда использовать

Включайте для Prometheus, VictoriaMetrics, Grafana Agent или другого scrape-агента. Для публичного сервера не открывайте `/metrics` наружу без аутентификации или сетевого allowlist: endpoint раскрывает нагрузку, throughput и косвенно параметры работы модели.

## Влияние на производительность и память

Обычный scrape дешевый, но каждый запрос проходит через очередь задач и читает состояние сервера. Слишком частый scrape может добавлять шум к HTTP thread pool и логам, но не должен существенно менять скорость генерации.

## Взаимодействие с другими аргументами

- `--api-key` защищает `/metrics`, потому что он не входит в public endpoints middleware.
- `--slots` управляет JSON endpoint `/slots`, но данные для `/metrics` собираются тем же типом task.
- В router-режиме README указывает, что для `/metrics` нужен query `?model=<model_id>`; без него router вернет `model name is missing from the request`.

## INI-пресеты и router-режим

В INI: `metrics = true` или `LLAMA_ARG_ENDPOINT_METRICS = true`. В router-режиме метрики отдельной модели запрашиваются через router с параметром `model`; внешний scrape должен учитывать список моделей.

## Типовые проблемы и диагностика

- JSON error `not_supported_error`: сервер запущен без `--metrics`.
- `401 Invalid API Key`: добавьте `Authorization: Bearer ...`.
- В router-режиме `model name is missing from the request`: добавьте `?model=<id>`.

## Примеры

```bash
llama-server --model /models/model.gguf --metrics
curl http://127.0.0.1:8080/metrics
curl "http://127.0.0.1:8080/metrics?model=my-model"
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
