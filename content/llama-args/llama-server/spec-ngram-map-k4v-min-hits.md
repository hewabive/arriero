---
schema: 1
primaryName: "--spec-ngram-map-k4v-min-hits"
title: "--spec-ngram-map-k4v-min-hits"
summary: "Минимальное число попаданий key n-gram перед тем, как `ngram-map-k4v` начнет предлагать draft. В отличие от simple/map-k legacy-порогов, этот параметр реально проверяется в текущем коде."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-map-k4v-min-hits"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-map-k4v-size-n"
  - "--spec-ngram-map-k4v-size-m"
  - "--spec-ngram-simple-min-hits"
  - "--spec-ngram-map-k-min-hits"
---

# --spec-ngram-map-k4v-min-hits

## Кратко

`--spec-ngram-map-k4v-min-hits` задает, сколько раз key n-gram должен встретиться в истории, прежде чем `ngram-map-k4v` разрешит speculative draft. Это рабочий фильтр качества для варианта `k4v`.

## Оригинальная справка llama.cpp

```text
minimum hits for ngram-map-k4v speculative decoding (default: 1)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-map-k4v-min-hits`
- Алиасы: нет
- Значение по умолчанию: `1`
- CLI-ограничение: значение должно быть `>= 1`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_map_k4v.min_hits`
- Runtime field: `common_ngram_map.min_hits`

## Что меняет в llama-server

В `common_ngram_map_draft()` после нахождения key увеличивается `key_num`. Если `key_num < min_hits`, функция возвращает пустой draft. После прохождения порога `k4v` собирает статистику value m-grams и использует наиболее частый вариант, если он достаточно сильнее остальных.

## Значения и формат

- Минимум `1`.
- Верхний предел в CLI не задан, но внутреннее поле `uint16_t`; используйте диапазон `1..65535`.
- Значение `1` означает "разрешить draft после первого учтенного совпадения".

## Когда использовать

Увеличивайте `min_hits`, если `k4v` слишком рано предлагает неверные черновики. Уменьшайте до `1`, если drafts почти не появляются, а текст содержит явные повторы.

## Влияние на производительность и память

Более высокий порог снижает число drafts и объем проверок главным контекстом, но может упустить ускорение на коротких повторяющихся фрагментах. Память меняется косвенно только через накопленные keys/values.

## Взаимодействие с другими аргументами

- `--spec-type ngram-map-k4v` включает реализацию.
- `--spec-ngram-map-k4v-size-n` влияет на то, как часто key повторяется.
- `--spec-ngram-map-k4v-size-m` задает длину value и draft.
- `--spec-ngram-simple-min-hits` и `--spec-ngram-map-k-min-hits` не являются эквивалентной рабочей настройкой в текущем commit.

## INI-пресеты и router-режим

```ini
spec-type = ngram-map-k4v
spec-ngram-map-k4v-min-hits = 2
```

## Типовые проблемы и диагностика

- Нет drafts при `min_hits > 1`: key не успевает повториться нужное число раз.
- Drafts есть, но низкая acceptance: увеличьте `min_hits` или `size_n`, уменьшите `size_m`.
- В verbose/debug логах полезны строки `key_num = ..., min_hits = ..., no draft`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k4v --spec-ngram-map-k4v-size-n 8 --spec-ngram-map-k4v-size-m 8 --spec-ngram-map-k4v-min-hits 2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.cpp`
- `llama.cpp/docs/speculative.md`
