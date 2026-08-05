---
schema: 1
primaryName: "--spec-ngram-map-k4v-size-m"
title: "--spec-ngram-map-k4v-size-m"
summary: "Длина value m-gram для `ngram-map-k4v`: столько токенов после key участвует в статистике вариантов продолжения и может попасть в draft."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-map-k4v-size-m"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-map-k4v-size-n"
  - "--spec-ngram-map-k4v-min-hits"
  - "--spec-draft-n-max"
---

# --spec-ngram-map-k4v-size-m

## Кратко

`--spec-ngram-map-k4v-size-m` задает длину m-gram values, которые `ngram-map-k4v` считает после key n-gram. Для каждого key хранится до четырех разных values; наиболее частый value используется как draft, если проходит проверки.

## Оригинальная справка llama.cpp

```text
ngram size M for ngram-map-k4v speculative decoding, length of draft m-gram (default: 48)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-map-k4v-size-m`
- Алиасы: нет
- Значение по умолчанию: `48`
- Допустимый диапазон: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_map_k4v.size_m`
- Runtime field: `common_ngram_map.size_value`

## Что меняет в llama-server

`size_m` определяет длину сравниваемых value m-grams и верхнюю длину draft. После частичного принятия `common_ngram_map_accept()` сохраняет `n_accepted`, и последующие drafts для этого value могут быть короче исходного `M`.

## Значения и формат

- `1..1024` принимаются.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size M must be between 1 and 1024 inclusive`.
- Итоговый draft может быть короче из-за `--spec-draft-n-max`, оставшихся `max_tokens`, свободного контекста или сохраненного `n_accepted`.

## Когда использовать

Большие значения подходят для повторяющихся длинных блоков, но требуют высокой стабильности продолжений. Для экспериментального `k4v` часто разумно начать с меньшего `M`, например `8..32`, и смотреть acceptance.

## Влияние на производительность и память

Чем больше `M`, тем больше токенов может проверяться главным контекстом за раз и тем дороже ошибочный draft. В памяти хранятся индексы value m-grams и статистика, а не копии всех токенов.

## Взаимодействие с другими аргументами

- `--spec-ngram-map-k4v-size-n` задает key.
- `--spec-ngram-map-k4v-min-hits` задает минимальное число key hits перед draft.
- `--spec-type ngram-map-k4v` нужен для активации.
- Удаленный `--spec-ngram-size-m` больше не работает.

## INI-пресеты и router-режим

```ini
spec-type = ngram-map-k4v
spec-ngram-map-k4v-size-m = 24
```

## Типовые проблемы и диагностика

- Draft слишком длинный и часто отклоняется: уменьшите `size_m`.
- Draft неожиданно короче `size_m`: проверьте `--spec-draft-n-max` и previous acceptance для этого value.
- Используйте `statistics ngram_map_k` и `draft acceptance = ...`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k4v --spec-ngram-map-k4v-size-n 12 --spec-ngram-map-k4v-size-m 24 --spec-ngram-map-k4v-min-hits 2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.h`
- `llama.cpp/common/ngram-map.cpp`
