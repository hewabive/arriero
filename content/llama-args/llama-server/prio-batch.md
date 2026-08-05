---
schema: 1
primaryName: "--prio-batch"
title: "--prio-batch"
summary: "Задает scheduler priority для batch/prompt worker threads. В отличие от основного `--prio`, batch-вариант принимает только `0..3`."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
allowedValues: []
env: []
related:
  - "--threads"
  - "--threads-batch"
  - "--cpu-mask-batch"
  - "--cpu-range-batch"
  - "--cpu-strict-batch"
  - "--poll-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --prio-batch

## Кратко

Задает scheduler priority для batch/prompt worker threads. В отличие от основного `--prio`, batch-вариант принимает только `0..3`.

## Оригинальная справка llama.cpp

```text
set process/thread priority : 0-normal, 1-medium, 2-high, 3-realtime (default: 0)
```

## Паспорт аргумента

- Основное имя: `--prio-batch`
- Алиасы: `--prio-batch`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `0`

## Что меняет в llama-server

Обработчик проверяет диапазон и записывает enum `ggml_sched_priority` в `params.cpuparams_batch.priority`. При создании ggml threadpool priority передается в `tpp.prio`, а CPU backend пытается применить его к worker threads через API ОС.

## Значения и формат

`0` normal, `1` medium, `2` high, `3` realtime. `-1` для `--prio-batch` не принимается: обработчик проверяет диапазон `0..3`. На Linux medium/high/realtime используют `SCHED_FIFO` с повышенными приоритетами и обычно требуют привилегий; без прав будет предупреждение `failed to set thread priority`.

## Когда использовать

Используйте осторожно на выделенных inference-хостах, где `llama-server` должен выигрывать CPU scheduling у фоновых задач. Для desktop, shared VM и публичного сервера чаще безопаснее оставить `0` или использовать `--prio -1` для фонового процесса.

## Влияние на производительность и память

Priority не ускоряет вычисления сам по себе, но может снизить latency под конкурирующей нагрузкой. Realtime/high priority способен ухудшить отзывчивость ОС и HTTP worker threads, особенно вместе с busy polling.

## Взаимодействие с другими аргументами

- Работает на том же batch threadpool, что `--threads-batch`, `--cpu-mask-batch`, `--cpu-strict-batch` и `--poll-batch`.
- Если batch CPU-профиль не задан, он наследует priority основного CPU-профиля.
- Повышенный priority вместе с высоким `--poll-batch` может заметно увеличить давление на CPU во время prompt ingestion.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `prio-batch = 1`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если batch-маска содержит меньше выставленных CPU, чем `--threads-batch`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --prio-batch 1
```

```bash
llama-server --model /models/model.gguf --prio-batch 2 --poll 20
```

```ini
[*]
prio-batch = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
