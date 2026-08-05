---
schema: 1
primaryName: "--spec-ngram-size-m"
title: "--spec-ngram-size-m"
summary: "Удаленный legacy-аргумент общего размера m-gram. Текущий `llama-server` отклоняет его; используйте `--spec-ngram-simple-size-m`, `--spec-ngram-map-k-size-m` или `--spec-ngram-map-k4v-size-m`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-size-m"
allowedValues: []
env: []
related:
  - "--spec-ngram-simple-size-m"
  - "--spec-ngram-map-k-size-m"
  - "--spec-ngram-map-k4v-size-m"
  - "--spec-ngram-mod-n-max"
---

# --spec-ngram-size-m

## Кратко

`--spec-ngram-size-m` удален. В текущем CLI он существует только для понятной ошибки миграции и не настраивает `common_params`.

## Оригинальная справка llama.cpp

```text
the argument has been removed. use the respective --spec-ngram-*-size-m
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-size-m`
- Статус в llama.cpp: удален
- Тип значения в help: `N`
- Переменные окружения: нет
- Runtime field: отсутствует
- Поведение при использовании: исключение `the argument has been removed. use the respective --spec-ngram-*-size-m`

## Что меняет в llama-server

С этим аргументом сервер не должен запускаться. Обработчик в `common/arg.cpp` вызывает `arg_removed()` и завершает парсинг ошибкой до инициализации speculative context.

## Чем заменить

- `--spec-ngram-simple-size-m` для `ngram-simple`.
- `--spec-ngram-map-k-size-m` для `ngram-map-k`.
- `--spec-ngram-map-k4v-size-m` для `ngram-map-k4v`.
- Для `ngram-mod` прямого `size-m` нет: длина черновика задается парой `--spec-ngram-mod-n-min` и `--spec-ngram-mod-n-max`.

## Значения и формат

Любое значение после `--spec-ngram-size-m` будет отвергнуто как использование удаленного аргумента. Не добавляйте этот ключ в UI или preset как допустимый параметр.

## INI-пресеты и router-режим

В preset-файлах удаленный ключ так же опасен, как в CLI:

```ini
; плохо: подпроцесс llama-server упадет на старте
spec-ngram-size-m = 48
```

Заменяйте его на ключ конкретной реализации.

## Типовые проблемы и диагностика

- Ошибка при загрузке модельного подпроцесса в router: проверьте `--models-preset` на legacy key `spec-ngram-size-m`.
- Если раньше один общий параметр применялся ко всем ngram вариантам, после миграции задайте отдельные значения для каждого включенного `--spec-type`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k --spec-ngram-map-k-size-m 48
```

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-min 48 --spec-ngram-mod-n-max 64
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/README.md`
