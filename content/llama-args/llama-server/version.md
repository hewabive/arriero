---
schema: 1
primaryName: "--version"
title: "--version"
summary: "Печатает build number, commit, compiler и target текущего бинарника, затем завершает процесс. Используется для диагностики, а не для запуска server instance."
category: "Общие параметры"
valueType: "flag"
estimation: "exits"
valueHint: null
aliases:
  - "--version"
allowedValues: []
env: []
related:
  - "--help"
  - "--completion-bash"
---

# --version

## Кратко

`--version` выводит сведения о сборке `llama-server` и сразу завершает процесс. Это правильный способ проверить, какой commit и build реально запускает service wrapper или arriero.

## Оригинальная справка llama.cpp

```text
show version and build info
```

## Паспорт аргумента

- Основное имя: `--version`
- Алиасы: `--version`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Переменные окружения: нет
- Этап применения: обработчик CLI вызывает вывод и `exit(0)`

## Что меняет в llama-server

В `common/arg.cpp` обработчик печатает в `stderr`:

```text
version: <build_number> (<commit>)
built with <compiler> for <target>
```

После этого вызывается `exit(0)`. Модель не загружается, HTTP server не стартует.

В этой версии отдельного `--license` в `llama-server --help` уже нет, поэтому `--version` и `--help` остаются основными встроенными diagnostic-флагами для сверки бинарника.

## Значения и формат

Флаг не принимает значение.

## Когда использовать

- После обновления или пересборки llama.cpp.
- При несоответствии help/hash и поведения runtime.
- В диагностике инцидента, чтобы отличить системный бинарник от локально собранного.

## Влияние на производительность и память

Минимальное: процесс печатает две строки и завершается.

## Взаимодействие с другими аргументами

Так как обработчик `--version` вызывает `exit(0)` прямо во время parsing, аргументы после него не имеют смысла для запуска сервера. Не храните `--version` в presets.

## INI-пресеты и router-режим

В `--models-preset` не применяйте. Дочерний process завершится вместо загрузки модели.

## Типовые проблемы и диагностика

- Управляемый instance сразу завершился с кодом 0: проверьте argv на наличие `--version`.
- Нужно понять, какой binary используется arriero: запустите тот же путь к бинарнику с `--version` вне постоянного instance config.

## Примеры

```bash
llama-server --version
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/README.md`
