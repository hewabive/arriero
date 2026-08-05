---
schema: 1
primaryName: "--spec-draft-cpu-range"
title: "--spec-draft-cpu-range"
summary: "Задает диапазон CPU affinity для generation-профиля draft-модели в формате `lo-hi` и дополняет `--spec-draft-cpu-mask`. В текущем `llama-server` draft affinity парсится, но применение к draft runtime не подтверждается кодом загрузки."
category: "Параметры speculative decoding"
valueType: "string"
estimation: "normal"
valueHint: "lo-hi"
aliases:
  - "-Crd"
  - "--cpu-range-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-cpu-mask"
  - "--spec-draft-cpu-strict"
  - "--spec-draft-threads"
  - "--cpu-range"
  - "--cpu-mask"
---

# --spec-draft-cpu-range

## Кратко

`--spec-draft-cpu-range` добавляет CPU range в affinity-маску generation-профиля draft-модели. Это удобная форма для `--spec-draft-cpu-mask`, когда нужные CPU идут подряд.

## Оригинальная справка llama.cpp

```text
Ranges of CPUs for affinity. Complements --cpu-mask-draft
```

## Паспорт аргумента

- Основное имя: `--spec-draft-cpu-range`
- Алиасы: `-Crd`, `--cpu-range-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `string`
- Подсказка формата: `lo-hi`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: наследуется из `--cpu-range`/`--cpu-mask`, если draft-профиль не задан

## Что меняет в llama-server

Обработчик выставляет `params.speculative.draft.cpuparams.mask_valid = true` и вызывает `parse_cpu_range()` для `params.speculative.draft.cpuparams.cpumask`. Диапазон добавляет `true` для всех CPU от start до end включительно. После парсинга draft CPU-профиль участвует в `postprocess_cpu_params()`.

Ограничение текущего server path такое же, как у `--spec-draft-cpu-mask`: при загрузке draft-модели `server-context.cpp` копирует из `params.speculative.draft.cpuparams` только `n_threads`. Поэтому range гарантированно валидируется и хранится в `common_params`, но его перенос в фактический draft runtime на commit `751ebd17...` не подтвержден.

## Значения и формат

Формат строго содержит дефис: `0-3`, `4-7`, `8-`. Если левая часть пустая, start становится `0`; если правая часть пустая, end становится `GGML_MAX_N_THREADS - 1`. Индексы `start` и `end` должны быть меньше `GGML_MAX_N_THREADS`, иначе парсер печатает `Start index out of bounds!` или `End index out of bounds!`.

Парсер не поддерживает список диапазонов в одном значении. Для нескольких групп используйте mask.

## Когда использовать

Используйте для читаемых CPU ranges вроде `0-3` вместо hex-маски `0x0f`. Для production pinning draft-модели проверьте фактическую affinity процесса/потоков внешними средствами, потому что server load path не копирует draft affinity целиком.

## Влияние на производительность и память

Диапазон CPU не меняет память. Он может улучшить locality только если affinity реально применена. Слишком узкий диапазон при большом `--spec-draft-threads` вызывает предупреждение `Not enough set bits in CPU mask ...` и может ухудшить throughput.

## Взаимодействие с другими аргументами

- `--spec-draft-cpu-mask` и `--spec-draft-cpu-range` дополняют одну mask.
- `--spec-draft-cpu-strict` определяет, получает ли каждый worker всю mask или отдельный CPU по кругу.
- `--spec-draft-threads` должен быть согласован с числом CPU в диапазоне.
- `--cpu-range` является fallback только когда draft CPU-профиль не задан.
- Для batch/prompt draft-профиля существует отдельный `--spec-draft-cpu-range-batch`.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `cpu-range-draft = 0-3`. Router не удаляет этот параметр из дочернего argv, но фактическое применение draft affinity зависит от кода загрузки draft-модели.

## Типовые проблемы и диагностика

- `Format of CPU range is invalid! Expected [<start>]-[<end>].` означает, что в значении нет дефиса.
- `Start index out of bounds!` или `End index out of bounds!` означает CPU index за пределами `GGML_MAX_N_THREADS`.
- Если range задан, но потоки draft не закреплены, проверьте ограничение `server-context.cpp` и используйте OS-level pinning как fallback.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-cpu-range 0-3
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
cpu-range-draft = 0-3
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление и обработчик `--spec-draft-cpu-range`.
- `llama.cpp/common/common.cpp` - `parse_cpu_range()` и `postprocess_cpu_params()`.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и копирование draft thread counts.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - runtime-механика CPU affinity в ggml threadpool.
- `llama.cpp/tools/server/README.md` - help-строка.
