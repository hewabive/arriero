---
schema: 1
primaryName: "--cpu-mask"
title: "--cpu-mask"
summary: "Задает CPU affinity основного CPU-профиля как hex-маску до 512 бит. Маска дополняет `--cpu-range` и применяется к ggml threadpool, если в ней есть хотя бы один установленный бит."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "M"
aliases:
  - "-C"
allowedValues: []
env: []
related:
  - "--threads-batch"
  - "--cpu-range"
  - "--cpu-strict"
  - "--prio"
  - "--poll"
  - "--numa"
  - "--cpu-mask-batch"
---

# --cpu-mask

## Кратко

Задает CPU affinity основного CPU-профиля как hex-маску до 512 бит. Маска дополняет `--cpu-range` и применяется к ggml threadpool, если в ней есть хотя бы один установленный бит.

## Оригинальная справка llama.cpp

```text
CPU affinity mask: arbitrarily long hex. Complements cpu-range (default: "")
```

## Паспорт аргумента

- Основное имя: `--cpu-mask`
- Алиасы: `-C`, `--cpu-mask`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата: `M`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `""`

## Что меняет в llama-server

Обработчик выставляет `mask_valid = true` и вызывает `parse_cpu_mask()` для основного CPU-профиля `params.cpuparams`. После загрузки контекста маска копируется в `ggml_threadpool_params.cpumask`; CPU backend применяет ее к worker threads через affinity API ОС, если маска не пустая.

## Значения и формат

Формат - hex-строка, например `ff`, `0xff`, `0000000f`. Парсер принимает цифры `0-9`, `a-f`, `A-F` и опциональный префикс `0x`. Обрабатываются максимум 128 hex-цифр, то есть 512 CPU-битов (`GGML_MAX_N_THREADS`). Младший бит последней hex-цифры соответствует CPU `0`: `0x3` выбирает CPU `0` и `1`, `0xf0` выбирает CPU `4-7`.

## Когда использовать

Используйте для закрепления генерации на конкретных ядрах: например, чтобы оставить часть CPU для HTTP threads, ОС и других сервисов, либо разнести несколько экземпляров `llama-server` по разным наборам CPU.

## Влияние на производительность и память

Affinity сама по себе не меняет память. Она может улучшить latency за счет cache locality и уменьшения миграций потоков, но слишком узкая маска при большом числе потоков ухудшит throughput. На Linux affinity ограничивается cpuset/cgroup процесса; недоступные CPU дадут предупреждение `failed to set affinity`.

## Взаимодействие с другими аргументами

- `--threads-batch` по умолчанию наследует итоговые настройки `--threads`, включая число потоков, affinity, priority, strict placement и polling, если batch-параметры не заданы отдельно.
- `--cpu-mask` и `--cpu-range` заполняют одну и ту же маску `params.cpuparams.cpumask`; при указании обоих аргументов биты фактически добавляются к уже выставленным.
- `--cpu-strict` меняет способ распределения потоков по выставленной маске: без него каждый поток получает всю маску, с ним потоки получают отдельные CPU по кругу.
- `--prio` и `--poll` применяются к тому же CPU threadpool, поэтому их стоит настраивать вместе с `--threads` и affinity.
- `--numa` включает отдельную NUMA-логику CPU backend; не смешивайте ее с ручной affinity, пока не измерили результат на конкретной машине.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `cpu-mask = 0xff`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если маска содержит меньше выставленных CPU, чем `--threads`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --cpu-mask 0xff --threads 8
```

```bash
llama-server --model /models/model.gguf --cpu-mask 0x0f --cpu-strict 1
```

```ini
[*]
cpu-mask = 0xff
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
