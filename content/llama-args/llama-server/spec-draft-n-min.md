---
schema: 1
primaryName: "--spec-draft-n-min"
title: "--spec-draft-n-min"
summary: "Задает минимальную длину draft-последовательности для draft-model/MTP speculative decoding. Если draft получился короче, он отбрасывается и target продолжает обычную генерацию."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-draft-n-min"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_N_MIN"
related:
  - "--spec-draft-n-max"
  - "--spec-draft-p-min"
  - "--spec-type"
  - "--spec-draft-model"
---

# --spec-draft-n-min

## Кратко

`--spec-draft-n-min` задает `common_params.speculative.draft.n_min`: минимальное число draft-токенов, при котором draft-model/MTP результат считается полезным. По умолчанию `0`, то есть короткие draft не отбрасываются по этому порогу.

В `draft-simple` и `draft-mtp` после попытки draft генерации код очищает `result`, если его размер меньше `n_min`.

## Оригинальная справка llama.cpp

```text
minimum number of draft tokens to use for speculative decoding (default: 0)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-n-min`
- Значение: целое число
- Структура llama.cpp: `common_params.speculative.draft.n_min`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_N_MIN`
- Значение по умолчанию: `0`
- Этап применения: draft generation, перед передачей draft на target verification

## Что меняет в llama-server

Если draft-модель остановилась рано из-за `--spec-draft-p-min`, `--spec-draft-n-max`, ошибки decode или отсутствия уверенного top-кандидата, `n_min` решает, использовать ли этот короткий draft. Пустой draft означает, что слот в этой итерации пойдет обычным sampling путем.

HTTP-поля `speculative.n_min` в server API сейчас закомментированы в `server-task.cpp`, поэтому runtime-запрос не переопределяет CLI/env.

## Значения и формат

Парсер принимает `int` без явной CLI-проверки диапазона. Для практической конфигурации используйте `0 <= n_min <= n_max`. Отрицательные значения не имеют полезного смысла; значения выше `n_max` будут приводить к отбрасыванию всех draft этой реализации.

## Когда использовать

Повышайте `n_min`, если короткие draft из 1-2 токенов не окупают overhead checkpoints/verification. Оставляйте `0`, если важна минимальная latency и даже короткие accepted draft дают выигрыш.

## Влияние на производительность и память

`n_min` почти не влияет на память, но влияет на эффективность: слишком высокий минимум может полностью подавить speculative decoding при умеренном `p_min`. Слишком низкий минимум может оставить много коротких draft с небольшим выигрышем.

## Взаимодействие с другими аргументами

`--spec-draft-p-min` и качество draft-модели определяют, удастся ли достичь `n_min`. `--spec-draft-n-max` должен быть не меньше `n_min`. При n-gram speculative используйте отдельные ngram параметры; этот аргумент относится к draft-model/MTP структуре.

## INI-пресеты и router-режим

В INI используйте `spec-draft-n-min = 2`. Значение стоит хранить вместе с конкретной парой target/draft, а не как глобальное для всех моделей.

## Типовые проблемы и диагностика

- Speculative включен, но draft не появляется: `n_min` выше достижимой длины draft.
- В логах мало accepted draft: уменьшите `n_min` или `p_min`, либо смените draft-модель.
- API-поле `speculative.n_min` не действует: runtime-adjustment отключен в текущем коде.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-n-max 8 --spec-draft-n-min 2
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-task.cpp`
