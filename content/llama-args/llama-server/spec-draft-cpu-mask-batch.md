---
schema: 1
primaryName: "--spec-draft-cpu-mask-batch"
title: "--spec-draft-cpu-mask-batch"
summary: "Парсит hex-маску CPU affinity для batch/prompt профиля draft-модели. По help наследует основной `--cpu-mask`, но в текущем server load path draft affinity batch-профиля не копируется явно в draft runtime."
category: "Параметры speculative decoding"
valueType: "string"
estimation: "normal"
valueHint: "M"
aliases:
  - "-Cbd"
  - "--cpu-mask-batch-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-threads-batch"
  - "--spec-draft-cpu-strict-batch"
  - "--spec-draft-cpu-mask"
  - "--cpu-mask-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --spec-draft-cpu-mask-batch

## Кратко

`--spec-draft-cpu-mask-batch` задает CPU affinity mask для batch/prompt CPU-профиля draft-модели. Это отдельная настройка от `--spec-draft-cpu-mask`, который относится к generation-профилю draft.

## Оригинальная справка llama.cpp

```text
Draft model CPU affinity mask. Complements cpu-range-draft (default: same as --cpu-mask)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-cpu-mask-batch`
- Алиасы: `-Cbd`, `--cpu-mask-batch-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `string`
- Подсказка формата: `M`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --cpu-mask` в help; фактическая постобработка batch-профиля draft наследует `params.cpuparams_batch`

## Что меняет в llama-server

Обработчик выставляет `params.speculative.draft.cpuparams_batch.mask_valid = true` и вызывает `parse_cpu_mask()` для batch CPU-профиля draft. Затем `postprocess_cpu_params(params.speculative.draft.cpuparams_batch, &params.cpuparams_batch)` наследует batch CPU-профиль target, если draft batch-профиль не задан.

В `server-context.cpp` при загрузке draft-модели копируются только `params_spec.cpuparams.n_threads` и `params_spec.cpuparams_batch.n_threads`. Mask batch-профиля не копируется явно, поэтому фактическое применение `--spec-draft-cpu-mask-batch` к draft runtime на проверенном commit не подтверждено.

## Значения и формат

Формат такой же, как у `--cpu-mask`: hex-строка с опциональным `0x`, максимум 128 hex-цифр. `0x3` выбирает CPU `0` и `1`; `0xf0` выбирает CPU `4-7`. Неверный символ вызывает `invalid cpumask`.

## Когда использовать

Используйте только после проверки, что ваша сборка применяет draft batch affinity. Цель параметра - отделить CPU prefill/batch draft-контекста от target batch-профиля, например при длинных prompts и CPU-bound draft model.

## Влияние на производительность и память

Память не меняется. При работающей affinity маска может улучшить locality batch/prompt фазы, но слишком узкая mask при большом `--spec-draft-threads-batch` ухудшит throughput и вызовет предупреждение о нехватке set bits.

## Взаимодействие с другими аргументами

- `--spec-draft-threads-batch` должен помещаться в выбранную mask.
- `--spec-draft-cpu-strict-batch` определяет strict placement для этой mask.
- `--spec-draft-cpu-range-batch` дополняет тот же batch mask.
- `--cpu-mask-batch` является fallback batch-профиля target.
- `--spec-draft-cpu-mask` относится к generation-профилю draft и не заменяет batch mask.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `cpu-mask-batch-draft = 0x0f`. Router не удаляет этот параметр из дочернего argv, но применение к draft runtime нужно проверять.

## Типовые проблемы и диагностика

- `invalid cpumask` означает неверный hex-формат.
- `Not enough set bits in CPU mask ...` означает, что mask уже, чем `--spec-draft-threads-batch`.
- Если batch affinity не видна в системных инструментах, проверьте ограничение `server-context.cpp`: batch mask draft-профиля не копируется явно.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-threads-batch 8 --spec-draft-cpu-mask-batch 0xff
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
threads-batch-draft = 8
cpu-mask-batch-draft = 0xff
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление и обработчик `--spec-draft-cpu-mask-batch`.
- `llama.cpp/common/common.cpp` - `parse_cpu_mask()` и `postprocess_cpu_params()`.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и копирование только thread counts.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - runtime affinity в ggml threadpool.
- `llama.cpp/tools/server/README.md` - help-строка.
