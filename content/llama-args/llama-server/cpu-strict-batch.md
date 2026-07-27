---
schema: 1
primaryName: "--cpu-strict-batch"
title: "--cpu-strict-batch"
summary: "Включает strict CPU placement для batch/prompt CPU-профиля. Если не задано, batch-профиль наследует значение `--cpu-strict`."
category: "Общие параметры"
valueType: "boolean"
valueHint: "<0|1>"
aliases:
allowedValues: []
env: []
related:
  - "--threads"
  - "--threads-batch"
  - "--cpu-mask-batch"
  - "--cpu-range-batch"
  - "--prio-batch"
  - "--poll-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --cpu-strict-batch

## Кратко

Включает strict CPU placement для batch/prompt CPU-профиля. Если не задано, batch-профиль наследует значение `--cpu-strict`.

## Оригинальная справка llama.cpp

```text
use strict CPU placement (default: same as --cpu-strict)
```

## Паспорт аргумента

- Основное имя: `--cpu-strict-batch`
- Алиасы: `--cpu-strict-batch`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `boolean`
- Подсказка формата: `<0|1>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --cpu-strict`

## Что меняет в llama-server

Обработчик записывает число в `params.cpuparams_batch.strict_cpu`. В `ggml_thread_cpumask_next()` значение `false` копирует всю affinity mask каждому worker thread, а значение `true` выбирает один следующий CPU из маски для каждого потока.

## Значения и формат

Ожидаемые значения - `0` или `1`. Для основного аргумента используется `std::stoul()`, поэтому отрицательные строки невалидны на этапе преобразования. Для batch-варианта обработчик принимает `int`, но help и семантика рассчитаны на `0`/`1`.

## Когда использовать

Используйте, когда нужно жестко разнести worker threads по ядрам внутри заданной маски. Это полезно для повторяемых benchmark, изоляции экземпляров и борьбы с миграцией потоков.

## Влияние на производительность и память

Может снизить jitter и улучшить cache locality, но при SMT/heterogeneous CPU иногда хуже, чем общая маска для всех потоков. Память не меняет. Без заданной affinity mask эффект отсутствует, потому что backend применяет strict placement к пустой маске как к отсутствующей affinity.

## Взаимодействие с другими аргументами

- Имеет смысл только вместе с непустой `--cpu-mask-batch` или `--cpu-range-batch`.
- Если batch CPU-профиль не задан, он наследует `--cpu-strict` вместе с остальным основным CPU-профилем.
- Значение должно соответствовать `--threads-batch`: если потоков больше, чем CPU в маске, CPU будут назначаться повторно.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `cpu-strict-batch = 1`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если batch-маска содержит меньше выставленных CPU, чем `--threads-batch`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --cpu-strict-batch 1 --cpu-range 0-7 --threads 8
```

```ini
[*]
cpu-strict-batch = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
