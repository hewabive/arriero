---
schema: 1
primaryName: "--log-timestamps"
title: "--log-timestamps"
summary: "Включает или отключает относительные timestamps в log prefix. `common_init()` включает timestamps по умолчанию."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--no-log-timestamps"
allowedValues: []
env:
  - "LLAMA_ARG_LOG_TIMESTAMPS"
related:
  - "--log-prefix"
  - "--log-colors"
  - "--log-file"
  - "--verbosity"
---

# --log-timestamps

## Кратко

Включает или отключает относительные timestamps в log prefix. `common_init()` включает timestamps по умолчанию.

## Оригинальная справка llama.cpp

```text
Enable timestamps in log messages
```

## Паспорт аргумента

- Основное имя: `--log-timestamps`
- Алиасы: `--log-timestamps`, `--no-log-timestamps`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `boolean`
- Подсказка формата: `нет значения`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_LOG_TIMESTAMPS`
- Значение по умолчанию: `enabled by common_init()`

## Что меняет в llama-server

Обработчик paired boolean вызывает `common_log_set_timestamps(common_log_main(), value)`. `common_init()` при старте уже включает timestamps, поэтому `--no-log-timestamps` нужен для явного отключения.

## Значения и формат

Используйте `--log-timestamps` или `--no-log-timestamps` без значения. В INI `log-timestamps = true` рендерится как `--log-timestamps`, `log-timestamps = false` как `--no-log-timestamps`.

## Когда использовать

Оставляйте timestamps включенными для сравнения фаз старта, загрузки модели, prefill и runtime ошибок. Отключайте, если внешний supervisor уже ставит timestamps и дублирование мешает обработке логов.

## Влияние на производительность и память

Влияние минимальное: вычисляется относительное время и добавляется короткий prefix. Память модели и throughput практически не меняет.

## Взаимодействие с другими аргументами

- `--verbosity` и `--verbose` определяют, какие сообщения вообще доходят до common logger.
- `--log-file`, `--log-colors`, `--log-prefix`, `--log-timestamps` управляют форматом и направлением тех сообщений, которые прошли threshold.
- `--log-disable` останавливает worker и отбрасывает новые записи; для `--log-file` и `--log-colors` порядок особенно важен, потому что эти настройки внутри себя делают pause/resume logger.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Если в логах нет относительного времени вида `0.00.035.060`, проверьте `--no-log-timestamps` и `--log-prefix`.
- Если timestamps дублируются с journald/systemd, используйте `--no-log-timestamps`.
- `--log-disable` скрывает все log output независимо от этой настройки.

## Примеры

```bash
llama-server --model /models/model.gguf --no-log-timestamps
```

```bash
llama-server --model /models/model.gguf --log-prefix --log-timestamps
```

```ini
[*]
log-timestamps = false
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--log-timestamps` и обработчик CLI/env.
- `llama.cpp/common/log.h` - log levels, prefix/timestamp format и публичные функции logger.
- `llama.cpp/common/log.cpp` - worker thread logger, file output, colors, pause/resume и threshold filtering.
- `llama.cpp/common/common.cpp` - `common_init()` включает prefix/timestamps и подключает callback libllama.
