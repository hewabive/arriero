---
schema: 1
primaryName: "--verbose"
title: "--verbose"
summary: "Устанавливает порог verbosity в `INT_MAX`: логируются все сообщения, а server tasks начинают добавлять `__verbose` в ответы, потому что `verbosity > 9`."
category: "Общие параметры"
valueType: "flag"
valueHint: null
aliases:
  - "-v"
  - "--log-verbose"
allowedValues: []
env: []
related:
  - "--verbosity"
  - "--log-file"
  - "--log-prefix"
  - "--log-timestamps"
---

# --verbose

## Кратко

`--verbose` - shortcut для максимальной подробности логов. Он выставляет `params.verbosity = INT_MAX` и сразу обновляет global log threshold через `common_log_set_verbosity_thold(INT_MAX)`.

## Оригинальная справка llama.cpp

```text
Set verbosity level to infinity (i.e. log all messages, useful for debugging)
```

## Паспорт аргумента

- Основное имя: `--verbose`
- Алиасы: `-v`, `--verbose`, `--log-verbose`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Подсказка формата: `нет значения`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `не включен`

## Что меняет в llama-server

Флаг влияет на общий logger `common_log_main()` и на server task defaults. В `server-task.cpp` поле request params `verbose` становится `true`, если базовая `verbosity > 9`; при `--verbose` это условие всегда выполнено, и ответы могут содержать служебный объект `__verbose` с подробностями prompt/request representation.

## Значения и формат

Флаг не принимает значение. Алиасы `-v`, `--verbose` и `--log-verbose` эквивалентны. Для численного контроля используйте `--verbosity N`.

## Когда использовать

Используйте для краткого debug-запуска: проблемы загрузки модели, tokenizer/chat template, routing, streaming, unexpected prompt formatting. Для постоянного публичного сервера флаг обычно слишком шумный и может раскрывать чувствительный prompt в логах или `__verbose` ответах.

## Влияние на производительность и память

Может заметно увеличить I/O, размер log file и объем JSON-ответов с `__verbose`. Модель, KV-cache и VRAM не меняет. На горячем сервере подробные логи могут стать bottleneck, особенно с `--log-file` на медленном диске.

## Взаимодействие с другими аргументами

- `--verbosity N` задает тот же threshold численно; если оба аргумента есть, фактическое значение зависит от порядка argv.
- `--log-file`, `--log-prefix`, `--log-timestamps` и `--log-colors` определяют, куда и в каком формате попадет большой объем debug output.
- `--log-disable` может отбросить логи, но порядок важен: некоторые logging-настройки вызывают pause/resume worker thread.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Если в API-ответе появился `__verbose`, проверьте `--verbose` или `--verbosity` больше `9`.
- Если debug-логи не видны, проверьте порядок с `--log-disable` и фактический threshold в строке `log_info: verbosity = ...`.
- Для отчета о bug полезно приложить `--verbose --log-file /tmp/llama-server-debug.log`, но сначала проверьте файл на секреты и пользовательские prompt.

## Примеры

```bash
llama-server --model /models/model.gguf --verbose
```

```bash
llama-server --model /models/model.gguf --verbose --log-file /tmp/llama-server-debug.log
```

```ini
[*]
verbose = true
```

## Источники

- `llama.cpp/common/arg.cpp` - обработчик `--verbose`.
- `llama.cpp/common/log.h` и `llama.cpp/common/log.cpp` - log levels и threshold.
- `llama.cpp/tools/server/server-task.cpp` - включение `__verbose` при `verbosity > 9`.
- `llama.cpp/tools/server/tests/unit/test_chat_completion.py` - тесты ответов с `__verbose`.
