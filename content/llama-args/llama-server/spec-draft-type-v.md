---
schema: 1
primaryName: "--spec-draft-type-v"
title: "--spec-draft-type-v"
summary: "Задает тип данных V-части KV-cache для draft-модели или MTP draft-контекста. Используется отдельно от `--cache-type-v` основной модели."
category: "Общие параметры"
valueType: "enum"
estimation: "normal"
valueHint: "TYPE"
aliases:
  - "--spec-draft-type-v"
  - "-ctvd"
  - "--cache-type-v-draft"
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
  - "LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_V"
related:
  - "--cache-type-v"
  - "--spec-draft-type-k"
  - "--spec-draft-model"
  - "--spec-draft-ngl"
  - "--spec-type"
---

# --spec-draft-type-v

## Кратко

`--spec-draft-type-v` задает тип хранения value tensor в KV-cache draft-контекста. Значение записывается в `common_params.speculative.draft.cache_type_v` и применяется при создании контекста draft-модели или MTP-контекста.

По умолчанию используется `f16`.

## Оригинальная справка llama.cpp

```text
KV cache data type for V for the draft model
allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1 (default: f16)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-type-v`
- Алиасы: `--spec-draft-type-v`, `-ctvd`, `--cache-type-v-draft`
- Структура llama.cpp: `common_params.speculative.draft.cache_type_v`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_V`
- Значение по умолчанию: `f16`
- Ошибка для неизвестного значения: `Unsupported cache type: ...`

## Что меняет в llama-server

Сервер копирует значение в `params_dft.cache_type_v` перед созданием draft-контекста. Для `draft-mtp` без отдельной модели значение идет в `cparams_mtp.type_v`. На target KV-cache этот аргумент не влияет.

## Значения и формат

Допустимы `f32`, `f16`, `bf16`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, `q5_1`. Значение передается одной строкой, без `TYPE=` и без списка.

## Когда использовать

Используйте квантованный V-cache, когда draft-контекст занимает слишком много памяти. Для стабильного baseline оставляйте `f16`; для экономии обычно сначала пробуют `q8_0`, затем более компактные типы.

## Влияние на производительность и память

V-cache часто занимает столько же порядка памяти, сколько K-cache, поэтому изменение `--spec-draft-type-v` заметно влияет на размер draft/MTP контекста. Более агрессивное квантование может снизить точность draft logits и acceptance.

## Взаимодействие с другими аргументами

Проверяйте вместе с `--spec-draft-type-k`: экономия памяти обычно нужна по обеим частям KV-cache. `--ctx-size`, `--parallel` и MTP sequence requirements увеличивают фактический размер KV.

## INI-пресеты и router-режим

В INI используйте `spec-draft-type-v = q8_0` или `cache-type-v-draft = q8_0`. Для router preset держите значение рядом с `spec-draft-type-k`, чтобы не получить неочевидную смесь типов.

## Типовые проблемы и диагностика

- Ошибка `Unsupported cache type`: значение не распознано `kv_cache_type_from_str()`.
- Низкая acceptance после изменения: верните `f16` или используйте менее агрессивный тип.
- OOM на старте: одного изменения V-cache может быть мало, меняйте также K-cache и offload draft-весов.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-type-k q8_0 --spec-draft-type-v q8_0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
