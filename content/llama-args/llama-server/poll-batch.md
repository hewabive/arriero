---
schema: 1
primaryName: "--poll-batch"
title: "--poll-batch"
summary: "Задает polling для batch/prompt CPU-профиля. Help показывает `0|1`, но поле хранит числовой уровень `uint32_t`, как и основной `--poll`."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: "<0|1>"
aliases:
allowedValues: []
env: []
related:
  - "--threads"
  - "--threads-batch"
  - "--cpu-mask-batch"
  - "--cpu-range-batch"
  - "--cpu-strict-batch"
  - "--prio-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --poll-batch

## Кратко

Задает polling для batch/prompt CPU-профиля. Help показывает `0|1`, но поле хранит числовой уровень `uint32_t`, как и основной `--poll`.

## Оригинальная справка llama.cpp

```text
use polling to wait for work (default: same as --poll)
```

## Паспорт аргумента

- Основное имя: `--poll-batch`
- Алиасы: `--poll-batch`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `boolean`
- Подсказка формата: `<0|1>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --poll`

## Что меняет в llama-server

Обработчик записывает значение в `params.cpuparams_batch.poll`. При создании ggml threadpool оно передается в `threadpool->poll`; CPU backend использует его как множитель числа spin rounds перед переходом к ожиданию через condition variable.

## Значения и формат

`0` отключает busy polling. Help для batch-варианта указывает `0|1`, обработчик принимает `int` и записывает его в `uint32_t`. Практически используйте `0` или `1`, если не хотите зависеть от неописанного поведения.

## Когда использовать

Используйте для тонкой настройки latency на CPU-bound сервере. Низкие значения лучше для shared-хоста и экономии CPU, более высокие могут помочь latency при частых коротких задачах, если серверу выделены ядра.

## Влияние на производительность и память

Повышает активное ожидание и потребление CPU даже между кусками работы. Память не меняет. В сочетании с высоким priority может сделать процесс агрессивным к соседним задачам.

## Взаимодействие с другими аргументами

- Работает на batch threadpool вместе с `--threads-batch`, batch affinity и `--prio-batch`.
- Если batch CPU-профиль не задан, он наследует polling основного CPU-профиля.
- Высокий polling на batch-фазе может ускорить короткие синхронизации, но ухудшить соседние HTTP и decode workload.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `poll-batch = 0`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если batch-маска содержит меньше выставленных CPU, чем `--threads-batch`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --poll-batch 0
```

```bash
llama-server --model /models/model.gguf --poll-batch 1 --threads-batch 8
```

```ini
[*]
poll-batch = 0
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
