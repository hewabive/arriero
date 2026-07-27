---
schema: 1
primaryName: "--verbosity"
title: "--verbosity"
summary: "Задает числовой порог логирования. Сообщения с verbosity выше порога игнорируются; значения `0..5` описаны в help, а `>9` дополнительно включает `__verbose` в server task responses."
category: "Общие параметры"
valueType: "number"
valueHint: "N"
aliases:
  - "-lv"
  - "--log-verbosity"
allowedValues: []
env:
  - "LLAMA_ARG_LOG_VERBOSITY"
related:
  - "--verbose"
  - "--log-file"
  - "--log-prefix"
  - "--log-timestamps"
  - "--log-disable"
---

# --verbosity

## Кратко

`--verbosity` задает global threshold для logger. Чем выше число, тем больше сообщений проходит; default `3` соответствует info-level.

## Оригинальная справка llama.cpp

```text
Set the verbosity threshold. Messages with a higher verbosity will be ignored. Values:
 - 0: generic output
 - 1: error
 - 2: warning
 - 3: info
 - 4: trace (more info)
 - 5: debug
(default: 3)
```

## Паспорт аргумента

- Основное имя: `--verbosity`
- Алиасы: `-lv`, `--verbosity`, `--log-verbosity`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_LOG_VERBOSITY`
- Значение по умолчанию: `3`

## Что меняет в llama-server

Обработчик записывает `params.verbosity = value` и вызывает `common_log_set_verbosity_thold(value)`. Макросы `LOG_*` сравнивают свой уровень с этим threshold до вычисления и записи сообщения. В server tasks `params.verbose` становится `true`, когда базовая `verbosity > 9`, что добавляет `__verbose` в ответы.

## Значения и формат

`N` - целое число. Help документирует `0..5`: `0` output, `1` error, `2` warning, `3` info, `4` trace, `5` debug. Обработчик не ограничивает верхнюю границу; значения выше `5` пропускают еще более подробные `LOGV` сообщения, а `>9` влияет на `__verbose` responses.

## Когда использовать

`1` или `2` подходят для тихого production-запуска. `3` оставляет нормальную стартовую диагностику. `4` и `5` используйте при расследовании проблем backend, загрузки модели, tokenization или routing. Значения `>9` применяйте точечно, потому что они могут раскрыть prompt details через `__verbose`.

## Влияние на производительность и память

Чем выше threshold, тем больше formatting, I/O и disk usage при `--log-file`. На память модели и KV-cache не влияет. При низком threshold часть дорогих log arguments не вычисляется благодаря `LOG_TMPL` guard.

## Взаимодействие с другими аргументами

- `--verbose` эквивалентен очень большому `--verbosity`; порядок аргументов определяет, кто победит, если указаны оба.
- `--log-file` сохраняет прошедшие threshold сообщения в файл и одновременно оставляет вывод в stdout/stderr.
- `--log-prefix` и `--log-timestamps` делают большой debug log пригоднее для анализа.
- `--log-disable` отбрасывает сообщения независимо от threshold, пока log worker paused.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр пишется по длинному имени без дефисов. Для paired boolean flags `common_preset::to_args()` выбирает положительный или отрицательный CLI-аргумент по boolean-значению. Logging-параметры не входят в список reserved router args, поэтому могут передаваться дочерним model servers; учитывайте, что `--log-file` в нескольких дочерних процессах должен указывать на разные файлы, иначе процессы будут конкурировать за один путь.

## Типовые проблемы и диагностика

- Фактический threshold печатается строкой `log_info: verbosity = N (adjust with the -lv N CLI arg)`.
- Если debug-сообщения не появились при `--verbosity 5`, проверьте, не задан ли позже `--log-disable`.
- Если API начал возвращать `__verbose`, ищите `--verbose` или `--verbosity` выше `9`.

## Примеры

```bash
llama-server --model /models/model.gguf --verbosity 2
```

```bash
llama-server --model /models/model.gguf --verbosity 5 --log-file /tmp/llama-debug.log
```

```ini
[*]
verbosity = 3
```

## Источники

- `llama.cpp/common/arg.cpp` - обработчик `--verbosity`.
- `llama.cpp/common/common.h` - default `verbosity = 3`.
- `llama.cpp/common/log.h` и `llama.cpp/common/log.cpp` - уровни логирования и threshold filtering.
- `llama.cpp/tools/server/server-task.cpp` - связь `verbosity > 9` с `__verbose`.
