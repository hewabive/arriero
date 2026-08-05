---
schema: 1
primaryName: "--spec-ngram-map-k-size-n"
title: "--spec-ngram-map-k-size-n"
summary: "Размер key n-gram для `ngram-map-k`: по этому окну токенов строится поиск предыдущего совпадения в истории слота. Активен только с `--spec-type ngram-map-k`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-map-k-size-n"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-map-k-size-m"
  - "--spec-ngram-map-k-min-hits"
  - "--spec-ngram-map-k4v-size-n"
---

# --spec-ngram-map-k-size-n

## Кратко

`--spec-ngram-map-k-size-n` задает длину key n-gram для `ngram-map-k`. В отличие от `ngram-simple`, этот вариант поддерживает per-slot `common_ngram_map` и hash map от n-gram hash к позиции в истории, чтобы ускорить поиск.

## Оригинальная справка llama.cpp

```text
ngram size N for ngram-map-k speculative decoding, length of lookup n-gram (default: 12)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-map-k-size-n`
- Алиасы: нет
- Значение по умолчанию: `12`
- Допустимый диапазон: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_map_k.size_n`
- Runtime field: `common_ngram_map.size_key`

## Что меняет в llama-server

`ngram-map-k` ищет текущий key n-gram в token history текущего слота. При совпадении он копирует следующие `--spec-ngram-map-k-size-m` токенов. В этой ветке `key_only=true`: учитывается сам факт совпадения key, а не распределение нескольких value m-grams.

## Значения и формат

- `1..1024` принимаются.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size N must be between 1 and 1024 inclusive`.
- При слишком большом `N` совпадения становятся редкими; при слишком малом растет риск ложных drafts.

## Когда использовать

Используйте для повторяющихся локальных шаблонов, где нужно быстрее, чем полный линейный поиск `ngram-simple`. Хороший старт - дефолт `12`.

## Влияние на производительность и память

Для каждого слота создается `common_ngram_map` с hash map на `262144` записей `uint32_t` плюс вектор найденных keys. Это больше памяти, чем `ngram-simple`, но меньше и локальнее, чем отдельная draft model.

## Взаимодействие с другими аргументами

- `--spec-type ngram-map-k` включает реализацию.
- `--spec-ngram-map-k-size-m` задает длину копируемого продолжения.
- `--spec-ngram-map-k-min-hits` в текущем commit не влияет на draft decision, потому что ветка `key_only` возвращает draft до проверки `min_hits`.
- `--spec-draft-n-max` может обрезать итоговый draft.

## INI-пресеты и router-режим

```ini
spec-type = ngram-map-k
spec-ngram-map-k-size-n = 12
```

Router не перезаписывает этот параметр; в preset он записывается без ведущих дефисов.

## Типовые проблемы и диагностика

- Нет `statistics ngram_map_k`: проверьте `--spec-type ngram-map-k`.
- Много неверных drafts: увеличьте `size_n` или уменьшите `size_m`.
- Слишком мало drafts: уменьшите `size_n` или проверьте наличие повторяющихся фрагментов в prompt/history.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k --spec-ngram-map-k-size-n 12 --spec-ngram-map-k-size-m 48
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.h`
- `llama.cpp/common/ngram-map.cpp`
