---
schema: 1
primaryName: "--log-disable"
title: "--log-disable"
summary: "Ставит common logger на pause: worker thread останавливается, а новые log entries отбрасываются. Порядок с другими log-флагами важен."
category: "Общие параметры"
valueType: "flag"
valueHint: null
aliases:
allowedValues: []
env: []
related:
  - "--log-file"
  - "--verbosity"
  - "--verbose"
  - "--log-prefix"
  - "--log-timestamps"
---

# --log-disable

## Кратко

Ставит common logger на pause: worker thread останавливается, а новые log entries отбрасываются. Порядок с другими log-флагами важен.

## Оригинальная справка llama.cpp

```text
Log disable
```

## Паспорт аргумента

- Основное имя: `--log-disable`
- Алиасы: `--log-disable`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Подсказка формата: `нет значения`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `не включен`

## Что меняет в llama-server

Обработчик вызывает `common_log_pause(common_log_main())`. В paused state log worker остановлен, а `common_log::add()` сразу возвращается без сохранения новых записей.

## Значения и формат

Флаг не принимает значение. Отрицательной пары `--no-log-disable` нет.

## Когда использовать

Используйте только для специальных benchmark или окружений, где stdout/stderr запрещены и диагностика не нужна. Для production обычно лучше снизить шум через `--verbosity 1` или `--verbosity 2`, а не полностью отключать логи.

## Влияние на производительность и память

Уменьшает log I/O и formatting после точки отключения, но лишает стартовой и runtime диагностики. На модель, KV-cache и VRAM не влияет.

## Взаимодействие с другими аргументами

- `--verbosity` и `--verbose` определяют, какие сообщения вообще доходят до common logger.
- `--log-file`, `--log-colors`, `--log-prefix`, `--log-timestamps` управляют форматом и направлением тех сообщений, которые прошли threshold.
- `--log-disable` останавливает worker и отбрасывает новые записи; для `--log-file` и `--log-colors` порядок особенно важен, потому что эти настройки внутри себя делают pause/resume logger.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Если после `--log-disable` все равно есть логи, проверьте порядок аргументов: `--log-file` и `--log-colors`, указанные позже, вызывают pause/resume и могут снова запустить worker.
- Если сервер падает без полезного вывода, временно уберите `--log-disable` или поставьте `--verbosity 5 --log-file ...`.

## Примеры

```bash
llama-server --model /models/model.gguf --log-disable
```

```ini
[*]
log-disable = true
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--log-disable` и обработчик CLI/env.
- `llama.cpp/common/log.h` - log levels, prefix/timestamp format и публичные функции logger.
- `llama.cpp/common/log.cpp` - worker thread logger, file output, colors, pause/resume и threshold filtering.
- `llama.cpp/common/common.cpp` - `common_init()` включает prefix/timestamps и подключает callback libllama.
