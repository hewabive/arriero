---
schema: 1
primaryName: "--spec-ngram-min-hits"
title: "--spec-ngram-min-hits"
summary: "Удаленный legacy-аргумент общего порога hits для ngram speculative decoding. Текущий `llama-server` отклоняет его; используйте variant-specific `--spec-ngram-*-min-hits` с учетом реального поведения каждого варианта."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-min-hits"
allowedValues: []
env: []
related:
  - "--spec-ngram-simple-min-hits"
  - "--spec-ngram-map-k-min-hits"
  - "--spec-ngram-map-k4v-min-hits"
---

# --spec-ngram-min-hits

## Кратко

`--spec-ngram-min-hits` удален. Если передать его в `llama-server`, парсер выбросит ошибку через `arg_removed()` и сервер не дойдет до загрузки модели.

## Оригинальная справка llama.cpp

```text
the argument has been removed. use the respective --spec-ngram-*-min-hits
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-min-hits`
- Статус в llama.cpp: удален
- Тип значения в help: `N`
- Переменные окружения: нет
- Runtime field: отсутствует
- Поведение при использовании: исключение `the argument has been removed. use the respective --spec-ngram-*-min-hits`

## Что меняет в llama-server

Ничего не меняет, потому что это removed marker. Значение не попадает в `common_params` и не может повлиять на speculative decoding.

## Чем заменить

- `--spec-ngram-map-k4v-min-hits` - рабочий порог для `ngram-map-k4v` в текущем commit.
- `--spec-ngram-simple-min-hits` парсится, но не используется в runtime `ngram-simple`.
- `--spec-ngram-map-k-min-hits` парсится, но в текущей ветке `key_only` не фильтрует drafts.

## Значения и формат

Формат `N` больше не имеет практического значения: любое значение после legacy-аргумента приводит к ошибке removed-аргумента.

## INI-пресеты и router-режим

Не используйте `spec-ngram-min-hits` в `--models-preset`. Если этот ключ остался после старой конфигурации, router передаст его модельному `llama-server`, и подпроцесс упадет при парсинге argv.

## Типовые проблемы и диагностика

- Ошибка `the argument has been removed`: удалите legacy key и выберите вариант-specific замену.
- После миграции проверьте, что выбранный `--spec-type` соответствует замененному параметру.
- Не переносите старое значение вслепую: у `simple`, `map-k` и `map-k4v` в текущем коде разная фактическая поддержка `min_hits`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k4v --spec-ngram-map-k4v-min-hits 2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.cpp`
- `llama.cpp/docs/speculative.md`
