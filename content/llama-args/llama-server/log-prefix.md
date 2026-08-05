---
schema: 1
primaryName: "--log-prefix"
title: "--log-prefix"
summary: "Включает или отключает prefix перед log messages. `common_init()` включает prefix по умолчанию, но paired flags позволяют явно управлять форматом."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--no-log-prefix"
allowedValues: []
env:
  - "LLAMA_ARG_LOG_PREFIX"
related:
  - "--log-timestamps"
  - "--log-colors"
  - "--log-file"
  - "--verbosity"
---

# --log-prefix

## Кратко

Включает или отключает prefix перед log messages. `common_init()` включает prefix по умолчанию, но paired flags позволяют явно управлять форматом.

## Оригинальная справка llama.cpp

```text
Enable prefix in log messages
```

## Паспорт аргумента

- Основное имя: `--log-prefix`
- Алиасы: `--log-prefix`, `--no-log-prefix`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `boolean`
- Подсказка формата: `нет значения`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_LOG_PREFIX`
- Значение по умолчанию: `enabled by common_init()`

## Что меняет в llama-server

Обработчик paired boolean вызывает `common_log_set_prefix(common_log_main(), value)`. Сам `common_init()` при старте уже включает prefix, поэтому `--no-log-prefix` нужен для явного отключения.

## Значения и формат

Используйте `--log-prefix` или `--no-log-prefix` без значения. В INI `log-prefix = true` рендерится как `--log-prefix`, `log-prefix = false` как `--no-log-prefix`.

## Когда использовать

Оставляйте prefix включенным для диагностики, потому что он добавляет однобуквенный уровень (`I`, `W`, `E`, `D`) и вместе с timestamps делает логи пригодными для расследования. Отключайте только для максимально компактного вывода или совместимости с парсером.

## Влияние на производительность и память

Влияние минимальное: несколько символов на строку. Память и inference не меняет.

## Взаимодействие с другими аргументами

- `--verbosity` и `--verbose` определяют, какие сообщения вообще доходят до common logger.
- `--log-file`, `--log-colors`, `--log-prefix`, `--log-timestamps` управляют форматом и направлением тех сообщений, которые прошли threshold.
- `--log-disable` останавливает worker и отбрасывает новые записи; для `--log-file` и `--log-colors` порядок особенно важен, потому что эти настройки внутри себя делают pause/resume logger.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Если уровни `I/W/E/D` не видны, проверьте `--no-log-prefix`.
- Если timestamp тоже нужен, включите `--log-timestamps`; timestamp печатается внутри prefix formatting.
- `--log-disable` может полностью скрыть эффект.

## Примеры

```bash
llama-server --model /models/model.gguf --no-log-prefix
```

```bash
llama-server --model /models/model.gguf --log-prefix --log-timestamps
```

```ini
[*]
log-prefix = true
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--log-prefix` и обработчик CLI/env.
- `llama.cpp/common/log.h` - log levels, prefix/timestamp format и публичные функции logger.
- `llama.cpp/common/log.cpp` - worker thread logger, file output, colors, pause/resume и threshold filtering.
- `llama.cpp/common/common.cpp` - `common_init()` включает prefix/timestamps и подключает callback libllama.
