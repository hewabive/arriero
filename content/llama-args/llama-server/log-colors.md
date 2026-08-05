---
schema: 1
primaryName: "--log-colors"
title: "--log-colors"
summary: "Управляет ANSI-цветами common logger: `on`, `off` или `auto`. Режим `auto` включает цвета только для terminal output."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "[on|off|auto]"
aliases:
allowedValues:
  - "on"
  - "off"
  - "auto"
env:
  - "LLAMA_ARG_LOG_COLORS"
related:
  - "--log-file"
  - "--log-prefix"
  - "--log-timestamps"
  - "--verbosity"
---

# --log-colors

## Кратко

Управляет ANSI-цветами common logger: `on`, `off` или `auto`. Режим `auto` включает цвета только для terminal output.

## Оригинальная справка llama.cpp

```text
Set colored logging ('on', 'off', or 'auto', default: 'auto')
'auto' enables colors when output is to a terminal
```

## Паспорт аргумента

- Основное имя: `--log-colors`
- Алиасы: `--log-colors`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата: `[on|off|auto]`
- Допустимые значения: `on`, `off`, `auto`
- Переменные окружения: `LLAMA_ARG_LOG_COLORS`
- Значение по умолчанию: `auto`

## Что меняет в llama-server

Обработчик принимает truthy/falsey/auto значение и вызывает `common_log_set_colors()`. `on` включает ANSI escape sequences, `off` заменяет цвета пустыми строками, `auto` вызывает `tty_can_use_colors()`.

## Значения и формат

Допустимы `on`, `off`, `auto` и другие truthy/falsey формы, которые распознают helpers `is_truthy()`/`is_falsey()`. Неизвестное значение вызывает ошибку `unknown value for --log-colors`.

## Когда использовать

Используйте `off` для log files, CI, journald и парсеров логов. Используйте `on` для интерактивной консоли, если auto не распознал terminal. `auto` - нормальный default для ручного запуска.

## Влияние на производительность и память

На inference и память не влияет. Цвета добавляют escape-последовательности в stderr/stdout; при записи в файл через `--log-file` те же строки могут содержать цвета, если они включены.

## Взаимодействие с другими аргументами

- `--verbosity` и `--verbose` определяют, какие сообщения вообще доходят до common logger.
- `--log-file`, `--log-colors`, `--log-prefix`, `--log-timestamps` управляют форматом и направлением тех сообщений, которые прошли threshold.
- `--log-disable` останавливает worker и отбрасывает новые записи; для `--log-file` и `--log-colors` порядок особенно важен, потому что эти настройки внутри себя делают pause/resume logger.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Если в файле видны символы вроде `\033[31m`, задайте `--log-colors off`.
- Если цвета не появились в terminal, проверьте `--log-colors on` и поддержку ANSI в консоли.
- Если аргумент не принят, используйте одно из `on`, `off`, `auto`.

## Примеры

```bash
llama-server --model /models/model.gguf --log-colors off --log-file /tmp/llama.log
```

```bash
llama-server --model /models/model.gguf --log-colors on
```

```ini
[*]
log-colors = off
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--log-colors` и обработчик CLI/env.
- `llama.cpp/common/log.h` - log levels, prefix/timestamp format и публичные функции logger.
- `llama.cpp/common/log.cpp` - worker thread logger, file output, colors, pause/resume и threshold filtering.
- `llama.cpp/common/common.cpp` - `common_init()` включает prefix/timestamps и подключает callback libllama.
