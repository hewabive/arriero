---
schema: 1
primaryName: "--cpu-mask-batch"
title: "--cpu-mask-batch"
summary: "Задает CPU affinity для batch/prompt CPU-профиля как hex-маску. Если batch-маска не задана, batch-профиль наследует основную маску `--cpu-mask`."
category: "Общие параметры"
valueType: "string"
valueHint: "M"
aliases:
  - "-Cb"
allowedValues: []
env: []
related:
  - "--threads"
  - "--threads-batch"
  - "--cpu-range-batch"
  - "--cpu-strict-batch"
  - "--prio-batch"
  - "--poll-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --cpu-mask-batch

## Кратко

Задает CPU affinity для batch/prompt CPU-профиля как hex-маску. Если batch-маска не задана, batch-профиль наследует основную маску `--cpu-mask`.

## Оригинальная справка llama.cpp

```text
CPU affinity mask: arbitrarily long hex. Complements cpu-range-batch (default: same as --cpu-mask)
```

## Паспорт аргумента

- Основное имя: `--cpu-mask-batch`
- Алиасы: `-Cb`, `--cpu-mask-batch`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата: `M`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --cpu-mask`

## Что меняет в llama-server

Обработчик выставляет `mask_valid = true` и вызывает `parse_cpu_mask()` для batch CPU-профиля `params.cpuparams_batch`. После загрузки контекста маска копируется в `ggml_threadpool_params.cpumask`; CPU backend применяет ее к worker threads через affinity API ОС, если маска не пустая.

## Значения и формат

Формат - hex-строка, например `ff`, `0xff`, `0000000f`. Парсер принимает цифры `0-9`, `a-f`, `A-F` и опциональный префикс `0x`. Обрабатываются максимум 128 hex-цифр, то есть 512 CPU-битов (`GGML_MAX_N_THREADS`). Младший бит последней hex-цифры соответствует CPU `0`: `0x3` выбирает CPU `0` и `1`, `0xf0` выбирает CPU `4-7`.

## Когда использовать

Используйте для закрепления batch/prompt processing на конкретных ядрах: например, чтобы оставить часть CPU для HTTP threads, ОС и других сервисов, либо разнести несколько экземпляров `llama-server` по разным наборам CPU.

## Влияние на производительность и память

Affinity сама по себе не меняет память. Она может улучшить latency за счет cache locality и уменьшения миграций потоков, но слишком узкая маска при большом числе потоков ухудшит throughput. На Linux affinity ограничивается cpuset/cgroup процесса; недоступные CPU дадут предупреждение `failed to set affinity`.

## Взаимодействие с другими аргументами

- `--cpu-range-batch` и `--cpu-mask-batch` заполняют одну batch-маску; при указании обоих значения объединяются.
- Если batch CPU-профиль не задан, он наследует основной профиль `--cpu-mask`/`--cpu-range` через `postprocess_cpu_params()`.
- `--threads-batch` должен быть согласован с количеством выставленных CPU, иначе появится предупреждение о нехватке set bits.
- `--cpu-strict-batch` определяет, получит ли каждый поток всю batch-маску или отдельный CPU из нее.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `cpu-mask-batch = 0xff00`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если batch-маска содержит меньше выставленных CPU, чем `--threads-batch`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --cpu-mask-batch 0xff --threads 8
```

```bash
llama-server --model /models/model.gguf --cpu-mask-batch 0x0f --cpu-strict 1
```

```ini
[*]
cpu-mask-batch = 0xff
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
