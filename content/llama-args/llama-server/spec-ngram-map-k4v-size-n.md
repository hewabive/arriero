---
schema: 1
primaryName: "--spec-ngram-map-k4v-size-n"
title: "--spec-ngram-map-k4v-size-n"
summary: "Размер key n-gram для экспериментального `ngram-map-k4v`, который хранит до четырех value m-grams на key и выбирает наиболее устойчивое продолжение."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-map-k4v-size-n"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-map-k4v-size-m"
  - "--spec-ngram-map-k4v-min-hits"
  - "--spec-ngram-map-k-size-n"
---

# --spec-ngram-map-k4v-size-n

## Кратко

`--spec-ngram-map-k4v-size-n` задает длину key n-gram для `ngram-map-k4v`. Этот вариант похож на `ngram-map-k`, но не ограничивается одним продолжением: для каждого key он ведет статистику до четырех value m-grams и выбирает наиболее частый, если он достаточно доминирует.

## Оригинальная справка llama.cpp

```text
ngram size N for ngram-map-k4v speculative decoding, length of lookup n-gram (default: 12)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-map-k4v-size-n`
- Алиасы: нет
- Значение по умолчанию: `12`
- Допустимый диапазон: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_map_k4v.size_n`
- Runtime field: `common_ngram_map.size_key`

## Что меняет в llama-server

Чем меньше key, тем чаще находятся совпадения, но тем выше риск разных продолжений для одного key. `ngram-map-k4v` частично компенсирует это статистикой value slots: draft создается только после `min_hits` и только если наиболее частый value не проигрывает конкурирующим продолжениям.

## Значения и формат

- `1..1024` принимаются.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size N must be between 1 and 1024 inclusive`.
- Размер считается в токенах.

## Когда использовать

`ngram-map-k4v` полезен для длинных повторов с несколькими возможными продолжениями, где простой `ngram-map-k` слишком охотно копирует первый найденный вариант. Начните с дефолта `12`; при редких drafts снижайте, при плохой acceptance rate повышайте.

## Влияние на производительность и память

Вариант дороже `ngram-map-k`: для key хранится до четырех value m-grams и статистика, а при draft обновляются counts. Память остается per-slot, без отдельной draft model.

## Взаимодействие с другими аргументами

- `--spec-type ngram-map-k4v` включает реализацию.
- `--spec-ngram-map-k4v-size-m` задает длину value m-gram.
- `--spec-ngram-map-k4v-min-hits` реально фильтрует drafts для этого варианта.
- `--spec-draft-n-max` может дополнительно обрезать draft.

## INI-пресеты и router-режим

```ini
spec-type = ngram-map-k4v
spec-ngram-map-k4v-size-n = 8
spec-ngram-map-k4v-size-m = 8
spec-ngram-map-k4v-min-hits = 2
```

## Типовые проблемы и диагностика

- Мало drafts: уменьшите `size_n` или `min_hits`.
- Низкая acceptance rate: увеличьте `size_n` или уменьшите `size_m`.
- Ищите в логах `adding speculative implementation 'ngram-map-k4v'` и финальную `statistics ngram_map_k`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k4v --spec-ngram-map-k4v-size-n 8 --spec-ngram-map-k4v-size-m 8 --spec-ngram-map-k4v-min-hits 2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.cpp`
- `llama.cpp/docs/speculative.md`
