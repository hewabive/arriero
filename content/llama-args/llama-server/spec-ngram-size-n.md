---
schema: 1
primaryName: "--spec-ngram-size-n"
title: "--spec-ngram-size-n"
summary: "Удаленный legacy-аргумент. В текущем llama.cpp его использование завершает парсинг ошибкой; вместо него нужно задавать variant-specific `--spec-ngram-*-size-n` или `--spec-ngram-mod-n-match`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-size-n"
allowedValues: []
env: []
related:
  - "--spec-ngram-simple-size-n"
  - "--spec-ngram-map-k-size-n"
  - "--spec-ngram-map-k4v-size-n"
  - "--spec-ngram-mod-n-match"
  - "--spec-type"
---

# --spec-ngram-size-n

## Кратко

`--spec-ngram-size-n` больше не поддерживается. Аргумент оставлен в `--help` как removed marker: если передать его в `llama-server`, обработчик вызывает `arg_removed()` и парсинг падает с ошибкой.

## Оригинальная справка llama.cpp

```text
the argument has been removed. use the respective --spec-ngram-*-size-n or --spec-ngram-mod-n-match
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-size-n`
- Статус в llama.cpp: удален
- Тип значения в help: `N`
- Переменные окружения: нет
- Runtime field: отсутствует
- Поведение при использовании: исключение `the argument has been removed. use the respective --spec-ngram-*-size-n`

## Что меняет в llama-server

Ничего не настраивает: сервер не должен стартовать с этим аргументом. В текущем `common/arg.cpp` обработчик не записывает значение в `common_params`, а сразу выбрасывает `std::invalid_argument`.

## Чем заменить

- Для `--spec-type ngram-simple`: `--spec-ngram-simple-size-n`.
- Для `--spec-type ngram-map-k`: `--spec-ngram-map-k-size-n`.
- Для `--spec-type ngram-map-k4v`: `--spec-ngram-map-k4v-size-n`.
- Для `--spec-type ngram-mod`: `--spec-ngram-mod-n-match`, потому что `ngram-mod` использует rolling hash key, а не общий `size-n`.

## Значения и формат

Формат `N` в `--help` оставлен только для сообщения совместимости. Любое значение приведет к ошибке removed-аргумента.

## INI-пресеты и router-режим

Не используйте `spec-ngram-size-n` в `--models-preset`: при преобразовании preset в argv это станет удаленным CLI-аргументом и подпроцесс модели не загрузится. Задавайте конкретный ключ варианта.

## Типовые проблемы и диагностика

- Лог содержит `the argument has been removed`: замените legacy key на один из variant-specific аргументов.
- После миграции проверьте, что включен соответствующий `--spec-type`; сами параметры размера не активируют speculative decoding.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-simple --spec-ngram-simple-size-n 12
```

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-match 24
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/README.md`
