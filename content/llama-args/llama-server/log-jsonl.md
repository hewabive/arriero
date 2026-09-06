---
schema: 1
primaryName: "--log-jsonl"
title: "--log-jsonl"
summary: "Переключает common logger на JSONL в stdout и файле логов. Удобен для сборщиков структурированных логов; по умолчанию выключен."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--no-log-jsonl"
allowedValues: []
env:
  - "LLAMA_ARG_LOG_JSONL"
related:
  - "--log-file"
  - "--log-colors"
  - "--log-prefix"
  - "--log-timestamps"
  - "--verbosity"
  - "--log-disable"
---

# --log-jsonl

## Кратко

Переключает common logger на один JSON-объект на строку. Сообщения всех уровней идут в stdout; при `--log-file` такие же объекты дополнительно пишутся в файл.

## Оригинальная справка llama.cpp

```text
Log as JSONL (one JSON object per line) to stdout, this also disables colored logging (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--log-jsonl`
- Отрицательная форма: `--no-log-jsonl`
- Категория: `Общие параметры`
- Тип: `boolean`, без значения в CLI
- Переменная окружения: `LLAMA_ARG_LOG_JSONL`
- Значение по умолчанию: `disabled`

## Что меняет в llama-server

Обработчик вызывает `common_log_set_jsonl()`. Новые записи получают JSONL-режим при добавлении в очередь. `common_log_entry::print()` сериализует поля `type` (строка `log`), `time`, `level`, `msg` и добавляет перевод строки. Переводы строк внутри `msg` экранируются; continuation-сообщения сохраняют уровень `cont` и не склеиваются автоматически.

Структурированная ветка обходит цветные префиксы common logger. Флаг не перехватывает прямые записи стороннего кода в stdout/stderr и не преобразует уже поставленные в очередь сообщения: не следует считать весь вывод процесса гарантированно чистым JSONL.

## Значения и формат

`--log-jsonl` включает режим, `--no-log-jsonl` возвращает текстовый вывод. `time` — микросекунды от создания logger при включённых timestamps, иначе `0`; это не абсолютное время Unix.

## Когда использовать

Для сборщика логов, который разбирает уровень и сообщение как отдельные поля. Настройте сбор stdout, даже если раньше собирали только stderr.

## Влияние на производительность и память

Не меняет память модели и KV-cache. JSON-сериализация и экранирование добавляют работу CPU и объём вывода; при подробном логировании возможны задержки I/O.

## Взаимодействие с другими аргументами

- `--log-file` дублирует JSONL в файл, открываемый с перезаписью на старте.
- `--log-prefix` не добавляет текст перед JSON; `--log-colors` не меняет структурированный формат.
- `--log-timestamps` управляет значением `time`, но не наличием поля.
- `--verbosity` сохраняет фильтрацию сообщений.
- `--log-disable` останавливает logger; переключение JSONL само по себе не вызывает pause/resume и не возобновляет его.

## INI-пресеты и router-режим

В INI используйте `log-jsonl = true` или `false`; paired boolean преобразуется в соответствующую форму CLI. Для разных дочерних серверов задавайте отдельные пути `--log-file`.

## Типовые проблемы и диагностика

- Пропали сообщения в stderr: в JSONL-режиме common logger пишет в stdout.
- Парсер не принимает отдельную строку: проверьте, пришла ли она через common logger, и не была ли выведена до разбора флага.
- `time` равен нулю: включите `--log-timestamps`.

## Примеры

```bash
llama-server --model /models/model.gguf --log-jsonl --log-timestamps --log-file /tmp/llama.jsonl
```

## Источники

- `llama.cpp/common/arg.cpp` — CLI/env и обработчик.
- `llama.cpp/common/log.cpp` — очередь, JSON-поля, маршрутизация и timestamps.
- https://github.com/ggml-org/llama.cpp/pull/28437 — добавление JSONL logging.
