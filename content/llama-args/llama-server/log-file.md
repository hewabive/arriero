---
schema: 1
primaryName: "--log-file"
title: "--log-file"
summary: "Открывает файл логов через common logger. Запись в файл добавляется к stdout/stderr, файл открывается в режиме `w` и перезаписывается на старте."
category: "Общие параметры"
valueType: "path"
estimation: "normal"
valueHint: "FNAME"
presetSupport: "router-managed"
aliases:
allowedValues: []
env:
  - "LLAMA_ARG_LOG_FILE"
related:
  - "--verbosity"
  - "--verbose"
  - "--log-disable"
  - "--log-prefix"
  - "--log-timestamps"
  - "--log-colors"
---

# --log-file

## Кратко

Открывает файл логов через common logger. Запись в файл добавляется к stdout/stderr, файл открывается в режиме `w` и перезаписывается на старте.

## Оригинальная справка llama.cpp

```text
Log to file
```

## Паспорт аргумента

- Основное имя: `--log-file`
- Алиасы: `--log-file`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `path`
- Подсказка формата: `FNAME`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_LOG_FILE`
- Значение по умолчанию: `не задан`

## Что меняет в llama-server

Обработчик вызывает `common_log_set_file(common_log_main(), value.c_str())`. В `log.cpp` текущий log worker ставится на pause, старый файл закрывается, новый путь открывается через `fopen(path, "w")`, затем worker возобновляется. Каждая новая запись печатается в stdout/stderr и дополнительно в файл.

## Значения и формат

`FNAME` - путь к файлу. Каталог должен существовать и быть доступен пользователю процесса; код не создает директории. Так как используется режим `w`, существующий файл будет обрезан при старте.

## Когда использовать

Используйте для управляемых экземпляров, systemd-сервисов, router child processes и debug-сессий, где stdout/stderr недостаточно удобны. Для нескольких дочерних серверов задавайте разные файлы или включайте модель/порт в имя файла.

## Влияние на производительность и память

На память модели и KV-cache не влияет. Может стать I/O bottleneck при `--verbose` или `--verbosity 5`; файл растет без ротации со стороны llama.cpp.

## Взаимодействие с другими аргументами

- `--verbosity` и `--verbose` определяют, какие сообщения вообще доходят до common logger.
- `--log-file`, `--log-colors`, `--log-prefix`, `--log-timestamps` управляют форматом и направлением тех сообщений, которые прошли threshold.
- `--log-disable` останавливает worker и отбрасывает новые записи; для `--log-file` и `--log-colors` порядок особенно важен, потому что эти настройки внутри себя делают pause/resume logger.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Если файл не появляется, проверьте права на каталог и абсолютный путь. `fopen()` в текущем коде не выбрасывает понятную CLI-ошибку при неудаче.
- Если файл пустой, проверьте `--log-disable` и порядок аргументов.
- Если несколько процессов пишут в один файл, разделите `--log-file` по экземплярам.

## Примеры

```bash
llama-server --model /models/model.gguf --log-file /var/log/llama/server.log
```

```bash
llama-server --model /models/model.gguf --verbosity 5 --log-file /tmp/llama-debug.log
```

```ini
[*]
log-file = /var/log/llama/model-a.log
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--log-file` и обработчик CLI/env.
- `llama.cpp/common/log.h` - log levels, prefix/timestamp format и публичные функции logger.
- `llama.cpp/common/log.cpp` - worker thread logger, file output, colors, pause/resume и threshold filtering.
- `llama.cpp/common/common.cpp` - `common_init()` включает prefix/timestamps и подключает callback libllama.
