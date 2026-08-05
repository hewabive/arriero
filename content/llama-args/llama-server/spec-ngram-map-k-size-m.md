---
schema: 1
primaryName: "--spec-ngram-map-k-size-m"
title: "--spec-ngram-map-k-size-m"
summary: "Длина value m-gram, который `ngram-map-k` копирует после найденного key n-gram. Итоговый draft может быть дополнительно обрезан общим лимитом speculative draft."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-map-k-size-m"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-map-k-size-n"
  - "--spec-ngram-map-k-min-hits"
  - "--spec-draft-n-max"
---

# --spec-ngram-map-k-size-m

## Кратко

`--spec-ngram-map-k-size-m` задает максимальный m-gram, который `ngram-map-k` берет из истории после найденного key n-gram. В runtime это `common_ngram_map.size_value`.

## Оригинальная справка llama.cpp

```text
ngram size M for ngram-map-k speculative decoding, length of draft m-gram (default: 48)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-map-k-size-m`
- Алиасы: нет
- Значение по умолчанию: `48`
- Допустимый диапазон: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_map_k.size_m`

## Что меняет в llama-server

При key match `ngram-map-k` копирует до `M` токенов после найденной позиции. Ветка `key_only` также учитывает `n_accepted` для последнего value slot, поэтому после частичного принятия будущий draft для этого key может стать короче.

## Значения и формат

- `1..1024` принимаются.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size M must be between 1 and 1024 inclusive`.
- Это число токенов, а не байтов или символов.

## Когда использовать

Поднимайте `M` для длинных повторов с высокой acceptance rate. Снижайте, если `statistics ngram_map_k` показывает много generated tokens при малом числе accepted tokens.

## Влияние на производительность и память

Большее `M` повышает потенциальный throughput, но увеличивает стоимость проверки и отката при неверном продолжении. Память карты в основном определяется числом keys и фиксированной hash map; `M` влияет на сравнение value ranges и длину draft.

## Взаимодействие с другими аргументами

- `--spec-ngram-map-k-size-n` определяет ключ поиска.
- `--spec-type ngram-map-k` включает реализацию.
- `--spec-draft-n-max` и оставшийся context могут сделать draft короче `M`.
- Удаленный `--spec-ngram-size-m` больше не задает этот параметр.

## INI-пресеты и router-режим

```ini
spec-type = ngram-map-k
spec-ngram-map-k-size-m = 48
```

## Типовые проблемы и диагностика

- Высокая latency без ускорения: уменьшите `size_m`.
- Черновики обрезаются ниже `size_m`: проверьте `--spec-draft-n-max`, `max_tokens` запроса и свободное место в контексте.
- Смотрите `draft acceptance = ...` и `statistics ngram_map_k`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k --spec-ngram-map-k-size-n 16 --spec-ngram-map-k-size-m 32
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.cpp`
- `llama.cpp/docs/speculative.md`
