---
schema: 1
primaryName: "--prio"
title: "--prio"
summary: "Задает scheduler priority для worker threads основного CPU-профиля. `-1` разрешен только для основного `--prio` и означает low priority."
category: "Общие параметры"
valueType: "number"
valueHint: "N"
aliases:
allowedValues: []
env: []
related:
  - "--threads-batch"
  - "--cpu-mask"
  - "--cpu-range"
  - "--cpu-strict"
  - "--poll"
  - "--numa"
  - "--prio-batch"
---

# --prio

## Кратко

Задает scheduler priority для worker threads основного CPU-профиля. `-1` разрешен только для основного `--prio` и означает low priority.

## Оригинальная справка llama.cpp

```text
set process/thread priority : low(-1), normal(0), medium(1), high(2), realtime(3) (default: 0)
```

## Паспорт аргумента

- Основное имя: `--prio`
- Алиасы: `--prio`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `0`

## Что меняет в llama-server

Обработчик проверяет диапазон и записывает enum `ggml_sched_priority` в `params.cpuparams.priority`. При создании ggml threadpool priority передается в `tpp.prio`, а CPU backend пытается применить его к worker threads через API ОС.

## Значения и формат

`0` normal, `1` medium, `2` high, `3` realtime. Основной `--prio` дополнительно принимает `-1` low. Значения вне диапазона вызывают `invalid value`. На Linux medium/high/realtime используют `SCHED_FIFO` с повышенными приоритетами и обычно требуют привилегий; без прав будет предупреждение `failed to set thread priority`.

## Когда использовать

Используйте осторожно на выделенных inference-хостах, где `llama-server` должен выигрывать CPU scheduling у фоновых задач. Для desktop, shared VM и публичного сервера чаще безопаснее оставить `0` или использовать `--prio -1` для фонового процесса.

## Влияние на производительность и память

Priority не ускоряет вычисления сам по себе, но может снизить latency под конкурирующей нагрузкой. Realtime/high priority способен ухудшить отзывчивость ОС и HTTP worker threads, особенно вместе с busy polling.

## Взаимодействие с другими аргументами

- `--threads-batch` по умолчанию наследует итоговые настройки `--threads`, включая число потоков, affinity, priority, strict placement и polling, если batch-параметры не заданы отдельно.
- `--cpu-mask` и `--cpu-range` заполняют одну и ту же маску `params.cpuparams.cpumask`; при указании обоих аргументов биты фактически добавляются к уже выставленным.
- `--cpu-strict` меняет способ распределения потоков по выставленной маске: без него каждый поток получает всю маску, с ним потоки получают отдельные CPU по кругу.
- `--prio` и `--poll` применяются к тому же CPU threadpool, поэтому их стоит настраивать вместе с `--threads` и affinity.
- `--numa` включает отдельную NUMA-логику CPU backend; не смешивайте ее с ручной affinity, пока не измерили результат на конкретной машине.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `prio = 1`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если маска содержит меньше выставленных CPU, чем `--threads`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --prio 1
```

```bash
llama-server --model /models/model.gguf --prio 2 --poll 20
```

```ini
[*]
prio = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
