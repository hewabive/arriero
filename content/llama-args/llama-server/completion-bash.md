---
schema: 1
primaryName: "--completion-bash"
title: "--completion-bash"
summary: "Печатает bash completion script для llama.cpp tools и завершает процесс. Используется для shell-интеграции, не для постоянного запуска `llama-server`."
category: "Общие параметры"
valueType: "flag"
estimation: "exits"
valueHint: null
aliases:
  - "--completion-bash"
allowedValues: []
env: []
related:
  - "--help"
  - "--version"
---

# --completion-bash

## Кратко

`--completion-bash` выводит bash completion script, который можно подключить в shell. Это одноразовая diagnostic/install command: после печати скрипта процесс завершает работу и не запускает HTTP server.

## Оригинальная справка llama.cpp

```text
print source-able bash completion script for llama.cpp
```

## Паспорт аргумента

- Основное имя: `--completion-bash`
- Алиасы: `--completion-bash`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Переменные окружения: нет
- Поле в `common_params`: `completion`
- Этап применения: после парсинга CLI, до проверки модели и до server runtime

## Что меняет в llama-server

В `common/arg.cpp` обработчик ставит `params.completion = true`. После успешного разбора `common_params_parse` вызывает `common_params_print_completion(ctx_arg)` и `exit(0)`. Проверка обязательной модели пропускается для completion path.

Скрипт генерируется из текущего набора аргументов parser-а, поэтому он отражает именно установленную версию llama.cpp.

В проверенной версии `llama.cpp` отдельного аргумента `--license` в `llama-server --help` уже нет: его удаление не влияет на completion path, но устаревшие shell completion файлы могли все еще содержать старую опцию.

## Значения и формат

Флаг не принимает значение.

## Когда использовать

- Для установки актуального bash completion после обновления llama.cpp.
- Для диагностики, какие option names parser считает доступными.
- Для shell-окружения разработчика, не для service process.

## Влияние на производительность и память

Модель не загружается, HTTP server не стартует. Команда печатает shell script в stdout и завершает процесс.

## Взаимодействие с другими аргументами

Другие runtime-аргументы не применяются к server runtime, потому что процесс завершается после генерации completion. Не добавляйте `--completion-bash` в instance config или model preset.

## INI-пресеты и router-режим

Не применимо для `--models-preset`. Если флаг окажется в preset дочерней модели, instance завершится после вывода completion script.

## Типовые проблемы и диагностика

- Instance не слушает порт и в логах bash function/script: удалите `--completion-bash` из argv.
- Completion устарел после обновления binary: сгенерируйте заново из того же `llama-server`, который реально используется.

## Примеры

```bash
llama-server --completion-bash
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/README.md`
