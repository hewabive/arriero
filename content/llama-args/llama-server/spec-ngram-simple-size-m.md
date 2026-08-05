---
schema: 1
primaryName: "--spec-ngram-simple-size-m"
title: "--spec-ngram-simple-size-m"
summary: "Длина m-gram продолжения, которое `ngram-simple` копирует после найденного совпадения. Чем больше значение, тем длиннее потенциальный draft и тем выше цена неверного совпадения."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-simple-size-m"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-simple-size-n"
  - "--spec-ngram-simple-min-hits"
  - "--spec-draft-n-max"
---

# --spec-ngram-simple-size-m

## Кратко

`--spec-ngram-simple-size-m` задает, сколько токенов после найденного n-gram совпадения `ngram-simple` пытается скопировать в speculative draft. В коде это `common_ngram_simple_config.size_mgram`.

## Оригинальная справка llama.cpp

```text
ngram size M for ngram-simple speculative decoding, length of draft m-gram (default: 48)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-simple-size-m`
- Алиасы: нет
- Значение по умолчанию: `48`
- Допустимый диапазон: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_simple.size_m`
- Применяется: при runtime draft generation для `ngram-simple`

## Что меняет в llama-server

После нахождения предыдущего совпадения длины `--spec-ngram-simple-size-n` алгоритм копирует до `M` следующих токенов из истории. Если после совпадения доступно меньше `size_n` токенов, `ngram-simple` возвращает пустой draft.

Итоговая длина может быть меньше `M`, потому что сервер затем обрезает draft по `dp.n_max`, который вычисляется из доступного контекста, оставшихся токенов генерации и общего `--spec-draft-n-max`.

## Значения и формат

- `1..1024` принимаются.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size M must be between 1 and 1024 inclusive`.
- Это число токенов в draft m-gram.

## Когда использовать

Увеличивайте `M` для длинных повторяющихся блоков, например при рефакторинге похожих участков кода. Уменьшайте, если accepted/generated ratio низкий или ответы короткие.

## Влияние на производительность и память

Память существенно не меняется. Большее `M` может дать хороший throughput при полном принятии черновиков, но при ложных совпадениях увеличивает объем batch-проверки и откатов.

## Взаимодействие с другими аргументами

- `--spec-type ngram-simple` включает алгоритм.
- `--spec-ngram-simple-size-n` определяет ключ поиска; `size_m` только задает длину продолжения.
- `--spec-ngram-simple-min-hits` сейчас не влияет на `ngram-simple`.
- `--spec-draft-n-max` может обрезать draft ниже `M`.

## INI-пресеты и router-режим

```ini
spec-type = ngram-simple
spec-ngram-simple-size-m = 48
```

В router-пресетах ключ задается без `--` и не относится к router-controlled параметрам.

## Типовые проблемы и диагностика

- Много rejected draft tokens: уменьшите `size_m` или увеличьте `size_n`.
- Draft не появляется на коротких запросах: нужен достаточно длинный контекст с уже встречавшимся продолжением.
- Проверяйте строки `statistics ngram_simple` и `draft acceptance = ...`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-simple --spec-ngram-simple-size-n 16 --spec-ngram-simple-size-m 32
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.cpp`
- `llama.cpp/tools/server/README.md`
