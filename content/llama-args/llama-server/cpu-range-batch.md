---
schema: 1
primaryName: "--cpu-range-batch"
title: "--cpu-range-batch"
summary: "Задает CPU affinity для batch/prompt CPU-профиля диапазоном индексов CPU. Если batch-профиль не задан, он наследует основной CPU-профиль."
category: "Общие параметры"
valueType: "string"
valueHint: "lo-hi"
aliases:
  - "-Crb"
allowedValues: []
env: []
related:
  - "--threads"
  - "--threads-batch"
  - "--cpu-mask-batch"
  - "--cpu-strict-batch"
  - "--prio-batch"
  - "--poll-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --cpu-range-batch

## Кратко

Задает CPU affinity для batch/prompt CPU-профиля диапазоном индексов CPU. Если batch-профиль не задан, он наследует основной CPU-профиль.

## Оригинальная справка llama.cpp

```text
ranges of CPUs for affinity. Complements --cpu-mask-batch
```

## Паспорт аргумента

- Основное имя: `--cpu-range-batch`
- Алиасы: `-Crb`, `--cpu-range-batch`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата: `lo-hi`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --cpu-range/--cpu-mask`

## Что меняет в llama-server

Обработчик выставляет `mask_valid = true` и вызывает `parse_cpu_range()` для batch CPU-профиля `params.cpuparams_batch`. Результат хранится в той же boolean-маске, что и hex form, а затем передается в параметры ggml threadpool.

## Значения и формат

Формат - один диапазон `lo-hi`. Левая или правая граница может быть пустой: `-7` означает CPU `0-7`, `8-` означает CPU `8` до `GGML_MAX_N_THREADS - 1`. Индексы должны быть меньше `512`. Парсер не принимает список через запятую; для нескольких участков используйте hex-маску или повторную комбинацию range/mask в CLI.

## Когда использовать

Используйте, когда диапазон читается проще hex-маски: например `--cpu-range 0-7` для одного CPU socket или `--cpu-range-batch 8-15` для вынесения prefill на другой набор CPU.

## Влияние на производительность и память

Влияние такое же, как у `--cpu-mask`: меньше миграций потоков и лучше предсказуемость, но риск недогрузить CPU или создать contention при слишком узком диапазоне. Память и KV-cache не меняются.

## Взаимодействие с другими аргументами

- `--cpu-range-batch` и `--cpu-mask-batch` объединяются в одной batch-маске.
- Если batch CPU-профиль не задан, он наследует основной профиль `--cpu-range`/`--cpu-mask`.
- Согласуйте диапазон с `--threads-batch` и `--cpu-strict-batch`, чтобы не сажать много потоков на слишком мало CPU.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `cpu-range-batch = 8-15`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если batch-маска содержит меньше выставленных CPU, чем `--threads-batch`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --cpu-range-batch 0-7 --threads 8
```

```bash
llama-server --model /models/model.gguf --cpu-range-batch 8- --cpu-strict 1
```

```ini
[*]
cpu-range-batch = 0-7
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
