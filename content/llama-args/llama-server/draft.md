---
schema: 1
primaryName: "--draft"
title: "--draft"
summary: "Legacy-аргумент удален из llama.cpp: передача `--draft`, `--draft-n` или `--draft-max` завершает парсинг ошибкой. Для draft-модели используйте `--spec-draft-n-max`, для ngram-mod - `--spec-ngram-mod-n-max`."
category: "Параметры speculative decoding"
valueType: "number"
valueHint: "N"
aliases:
  - "--draft-n"
  - "--draft-max"
allowedValues: []
env:
  - "LLAMA_ARG_DRAFT_MAX"
related:
  - "--spec-draft-n-max"
  - "--spec-ngram-mod-n-max"
  - "--spec-draft-model"
  - "--spec-type"
---

# --draft

## Кратко

`--draft` больше не является рабочим параметром speculative decoding. В текущем llama.cpp он оставлен только как removed stub, чтобы запуск завершался понятной ошибкой и подсказывал новые аргументы.

## Оригинальная справка llama.cpp

```text
the argument has been removed. use --spec-draft-n-max or --spec-ngram-mod-n-max
```

## Паспорт аргумента

- Основное имя: `--draft`
- Алиасы: `--draft-n`, `--draft-max`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не применимо, аргумент удален`
- Переменные окружения: `LLAMA_ARG_DRAFT_MAX`
- Значение по умолчанию: `не применимо`

## Что меняет в llama-server

Ничего не настраивает. В `common/arg.cpp` обработчик вызывает `arg_removed("use --spec-draft-n-max or --spec-ngram-mod-n-max")`, а `arg_removed()` бросает `std::invalid_argument` с текстом `the argument has been removed...`. Сервер не доходит до загрузки модели.

Переменная окружения `LLAMA_ARG_DRAFT_MAX` тоже привязана к removed stub: если она используется как источник значения для этого аргумента, запуск должен завершиться той же ошибкой.

## Значения и формат

Формально help показывает `N`, но любые значения бесполезны: `--draft 4`, `--draft-n 4` и `--draft-max 4` все ведут к ошибке парсинга. Не храните этот параметр в конфигурациях arriero и INI-пресетах.

## Когда использовать

Не использовать. При миграции старых конфигураций выбирайте новый аргумент по типу speculative decoding:

- `--spec-draft-n-max` - максимум draft tokens для draft-модели (`draft-simple`/draft context);
- `--spec-ngram-mod-n-max` - максимум токенов для ngram-mod speculative decoding.

## Влияние на производительность и память

Параметр не влияет на производительность или память, потому что сервер завершается на этапе разбора аргументов.

## Взаимодействие с другими аргументами

- `--spec-draft-n-max` заменяет legacy `--draft` для draft-модели.
- `--spec-ngram-mod-n-max` заменяет legacy `--draft` для ngram-mod.
- `--spec-draft-model` и `--spec-type` определяют, какой speculative mechanism активен; сам `--draft` больше не участвует.
- `--draft-min` удален отдельно и заменяется `--spec-draft-n-min` или `--spec-ngram-mod-n-min`.

## INI-пресеты и router-режим

Не добавляйте `draft`, `draft-n`, `draft-max` или `LLAMA_ARG_DRAFT_MAX` в `--models-preset`. Router передает нерезервированные параметры дочернему `llama-server`, и removed stub остановит дочерний процесс при загрузке модели.

## Типовые проблемы и диагностика

- Ошибка запуска с текстом `the argument has been removed. use --spec-draft-n-max or --spec-ngram-mod-n-max` означает, что в argv, env или preset остался legacy-параметр.
- Проверьте systemd unit, docker args, arriero instance config и `--models-preset`.
- Если migration target неочевиден, посмотрите `--spec-type`: для draft-модели используйте `--spec-draft-n-max`, для ngram-mod - `--spec-ngram-mod-n-max`.

## Примеры

Старую форму удалите:

```bash
llama-server --model /models/target.gguf --draft 5
```

Для draft-модели используйте:

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-n-max 5
```

Для ngram-mod используйте:

```bash
llama-server --model /models/target.gguf --spec-type ngram-mod --spec-ngram-mod-n-max 64
```

## Источники

- `llama.cpp/common/arg.cpp` - removed stub для `--draft`, `--draft-n`, `--draft-max`, env `LLAMA_ARG_DRAFT_MAX` и `arg_removed()`.
- `llama.cpp/common/speculative.cpp` - выбор draft/ngram speculative implementations.
- `llama.cpp/tools/server/README.md` - help-строка removed аргумента.
