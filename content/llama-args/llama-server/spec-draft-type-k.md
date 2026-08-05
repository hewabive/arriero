---
schema: 1
primaryName: "--spec-draft-type-k"
title: "--spec-draft-type-k"
summary: "Задает тип данных K-части KV-cache для draft-модели или MTP draft-контекста. Квантованные типы уменьшают память draft-контекста, но могут менять скорость и acceptance."
category: "Общие параметры"
valueType: "enum"
estimation: "normal"
valueHint: "TYPE"
aliases:
  - "--spec-draft-type-k"
  - "-ctkd"
  - "--cache-type-k-draft"
allowedValues:
  - "f32"
  - "f16"
  - "bf16"
  - "q8_0"
  - "q4_0"
  - "q4_1"
  - "iq4_nl"
  - "q5_0"
  - "q5_1"
env:
  - "LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_K"
related:
  - "--cache-type-k"
  - "--spec-draft-type-v"
  - "--spec-draft-model"
  - "--spec-draft-ngl"
  - "--spec-type"
---

# --spec-draft-type-k

## Кратко

`--spec-draft-type-k` задает тип хранения key tensor в KV-cache draft-контекста. Значение записывается в `common_params.speculative.draft.cache_type_k`, затем копируется в `params_dft.cache_type_k` для отдельной draft-модели или в `cparams_mtp.type_k` для MTP-контекста.

По умолчанию используется `f16`.

## Оригинальная справка llama.cpp

```text
KV cache data type for K for the draft model
allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1 (default: f16)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-type-k`
- Алиасы: `--spec-draft-type-k`, `-ctkd`, `--cache-type-k-draft`
- Структура llama.cpp: `common_params.speculative.draft.cache_type_k`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_K`
- Значение по умолчанию: `f16`
- Ошибка для неизвестного значения: `Unsupported cache type: ...`

## Что меняет в llama-server

При создании draft-контекста тип K передается в `llama_context_params::type_k`. Это влияет на память KV-cache draft-модели, а не на KV-cache target-модели. Target управляется отдельным `--cache-type-k`.

Для `--spec-type draft-mtp` без отдельной draft-модели этот параметр все равно применяется: сервер создает MTP context against target model и выставляет `cparams_mtp.type_k`.

## Значения и формат

Допустимы только строки из списка `f32`, `f16`, `bf16`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, `q5_1`. Регистр должен совпадать с `ggml_type_name()`, используйте lowercase как в help.

## Когда использовать

Оставляйте `f16`, если draft KV-cache не является главным потребителем памяти. Переходите на `q8_0` или более компактные типы, когда draft/MTP контекст мешает разместить target-модель или большой `--parallel`.

Меняйте K и V типы вместе только после проверки качества и скорости: разные backend могут по-разному ускорять или замедлять квантованный KV.

## Влияние на производительность и память

Квантованные типы уменьшают память draft KV-cache, но могут добавить конвертации или снизить точность draft logits. Если acceptance падает, общий throughput может ухудшиться даже при меньшей памяти.

Смотрите логи speculative init: `cache_k=...` и строку `[spec] estimated memory usage ...` при включенном fit.

## Взаимодействие с другими аргументами

`--spec-draft-type-v` задает V-часть того же draft KV-cache. `--ctx-size` и `--parallel` косвенно увеличивают объем draft KV-cache. `--cache-type-k` не заменяет этот аргумент для draft-контекста.

## INI-пресеты и router-режим

В INI используйте `spec-draft-type-k = q8_0` или `cache-type-k-draft = q8_0`. Для preset с MTP это имеет смысл даже без `model-draft`.

## Типовые проблемы и диагностика

- `Unsupported cache type`: значение не входит в список или указан неверный регистр.
- OOM сохраняется: уменьшите также `--spec-draft-type-v`, `--spec-draft-ngl`, `--parallel` или context size.
- Acceptance просела после квантования KV: верните `f16` и сравните `draft acceptance`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-type-k q8_0 --spec-draft-type-v q8_0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
