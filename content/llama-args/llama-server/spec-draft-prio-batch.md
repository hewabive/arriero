---
schema: 1
primaryName: "--spec-draft-prio-batch"
title: "--spec-draft-prio-batch"
summary: "Задает scheduler priority для batch/prompt CPU-профиля draft-модели: `0` normal, `1` medium, `2` high, `3` realtime. Значение `-1` здесь запрещено."
category: "Параметры speculative decoding"
valueType: "number"
valueHint: "N"
aliases:
  - "--prio-batch-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-prio"
  - "--spec-draft-threads-batch"
  - "--spec-draft-poll-batch"
  - "--prio-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --spec-draft-prio-batch

## Кратко

`--spec-draft-prio-batch` задает scheduler priority для batch/prompt CPU-профиля draft-модели. Это отдельный параметр от `--spec-draft-prio`, который относится к generation-профилю draft.

## Оригинальная справка llama.cpp

```text
set draft process/thread priority : 0-normal, 1-medium, 2-high, 3-realtime (default: 0)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-prio-batch`
- Алиасы: `--prio-batch-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `0`

## Что меняет в llama-server

CLI-обработчик проверяет диапазон `0..3` и записывает enum `ggml_sched_priority` в `params.speculative.draft.cpuparams_batch.priority`. Значения вне диапазона вызывают `invalid value`.

В общем CPU helper priority переносится в `ggml_threadpool_params.prio`. В текущем `server-context.cpp` при загрузке draft-модели явно копируются только thread counts, поэтому batch priority draft-профиля не подтвержден как применяемый runtime-параметр для `llama-server` на commit `751ebd17...`.

## Значения и формат

Допустимы `0` normal, `1` medium, `2` high, `3` realtime. `-1` low запрещен, в отличие от основного `--prio`.

## Когда использовать

Используйте с осторожностью на выделенных CPU, если draft prefill/batch стабильно bottleneck и вы подтвердили применение параметра. Для shared-серверов и публичных endpoint лучше оставить `0`, потому что high/realtime batch priority может ухудшить target и HTTP latency.

## Влияние на производительность и память

Память не меняется. Priority может уменьшить ожидание CPU под конкурирующей нагрузкой, но не ускоряет сами операции. На Linux повышенные уровни обычно требуют прав на realtime scheduling; без прав возможны предупреждения `failed to set thread priority`.

## Взаимодействие с другими аргументами

- `--spec-draft-poll-batch` вместе с высоким priority повышает риск агрессивной CPU-загрузки.
- `--spec-draft-threads-batch` определяет число batch workers draft-профиля.
- `--prio-batch` задает target batch priority и является более широким fallback-профилем.
- `--spec-draft-prio` относится к generation-профилю draft.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `prio-batch-draft = 1`. Router не удаляет этот параметр, но фактическое применение к draft batch runtime нужно проверять.

## Типовые проблемы и диагностика

- `invalid value` означает значение вне `0..3`.
- `failed to set thread priority` означает отказ ОС применить scheduler priority.
- Если параметр не влияет на поведение, учитывайте, что `server-context.cpp` не копирует draft batch priority явно.
- При деградации latency уменьшите priority и отключите batch polling draft-профиля.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-threads-batch 8 --spec-draft-prio-batch 1
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
threads-batch-draft = 8
prio-batch-draft = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление, диапазон `0..3` и обработчик `--spec-draft-prio-batch`.
- `llama.cpp/common/common.h` - CPU priority fields.
- `llama.cpp/common/common.cpp` - перенос CPU params в threadpool params.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и ограничение копирования CPU-профиля.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение thread priority.
- `llama.cpp/tools/server/README.md` - help-строка.
