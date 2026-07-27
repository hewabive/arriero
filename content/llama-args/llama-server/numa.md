---
schema: 1
primaryName: "--numa"
title: "--numa"
summary: "Включает NUMA-стратегию CPU backend: `distribute`, `isolate` или `numactl`. По умолчанию NUMA-оптимизации выключены; пустое значение в обработчике соответствует `distribute`."
category: "Общие параметры"
valueType: "string"
valueHint: "TYPE"
aliases:
allowedValues:
  - "distribute"
  - "isolate"
  - "numactl"
env:
  - "LLAMA_ARG_NUMA"
related:
  - "--threads"
  - "--threads-batch"
  - "--cpu-mask"
  - "--cpu-range"
  - "--cpu-strict"
  - "--cpu-mask-batch"
  - "--cpu-range-batch"
---

# --numa

## Кратко

`--numa` включает NUMA-aware размещение потоков CPU backend. Это низкоуровневая настройка для многосокетных Linux-систем и машин с выраженной NUMA-топологией; на обычном desktop без NUMA она обычно не нужна.

## Оригинальная справка llama.cpp

```text
attempt optimizations that help on some NUMA systems
- distribute: spread execution evenly over all nodes
- isolate: only spawn threads on CPUs on the node that execution started on
- numactl: use the CPU map provided by numactl
if run without this previously, it is recommended to drop the system page cache before using this
see https://github.com/ggml-org/llama.cpp/issues/1437
```

## Паспорт аргумента

- Основное имя: `--numa`
- Алиасы: `--numa`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата: `TYPE`
- Допустимые значения: `distribute`, `isolate`, `numactl`
- Переменные окружения: `LLAMA_ARG_NUMA`
- Значение по умолчанию: `disabled`

## Что меняет в llama-server

Обработчик записывает enum в `params.numa`: `GGML_NUMA_STRATEGY_DISTRIBUTE`, `GGML_NUMA_STRATEGY_ISOLATE` или `GGML_NUMA_STRATEGY_NUMACTL`. В `server.cpp` после `llama_backend_init()` вызывается `llama_numa_init(params.numa)`, который передает стратегию в CPU backend через `ggml_backend_cpu_numa_init`.

## Значения и формат

- `distribute` распределяет execution по NUMA nodes.
- `isolate` ограничивает потоки CPU node, на котором стартовало выполнение.
- `numactl` использует CPU map, уже заданную внешним `numactl`/cpuset.

Пустая строка в обработчике также выбирает `distribute`, но в CLI arriero лучше задавать явное значение. Любое другое значение вызывает `invalid value`.

## Когда использовать

Используйте на многосокетных серверах, где память модели и CPU threads могут оказаться на разных NUMA nodes. `numactl` полезен, когда размещение процесса уже задается systemd, Kubernetes cpuset или ручной командой `numactl`. `isolate` подходит для закрепления экземпляра на node запуска.

## Влияние на производительность и память

Может уменьшить remote memory access и улучшить throughput CPU inference, но при неправильной стратегии может ухудшить результат. Размер модели, KV-cache и VRAM не меняет. Help llama.cpp отдельно предупреждает, что после запуска без NUMA перед повторным запуском с NUMA может быть полезно сбросить page cache, потому что mmap/page placement уже могли закрепиться неудачно.

## Взаимодействие с другими аргументами

- `--threads` и `--threads-batch` определяют количество CPU worker threads, на которые влияет NUMA placement.
- `--cpu-mask`/`--cpu-range` и batch affinity могут конфликтовать с выбранной NUMA-стратегией; измеряйте итоговую комбинацию, а не отдельные флаги.
- `--mmap` влияет на то, как страницы модели попадают в память ОС; именно поэтому page cache важен для NUMA-экспериментов.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `numa = isolate`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если после `--numa` производительность ухудшилась, проверьте topology через `numactl --hardware`, cpuset процесса и фактические CPU в affinity mask.
- Предупреждения `pthread_setaffinity_np() failed` означают, что backend не смог применить NUMA affinity.
- Для честного сравнения перезапускайте сервер и прогревайте одинаковым prompt; NUMA и page cache делают одиночные измерения шумными.

## Примеры

```bash
llama-server --model /models/model.gguf --numa distribute --threads 32
```

```bash
llama-server --model /models/model.gguf --numa numactl
```

```ini
[*]
numa = isolate
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--numa` и допустимые значения.
- `llama.cpp/common/common.h` - default `GGML_NUMA_STRATEGY_DISABLED`.
- `llama.cpp/tools/server/server.cpp` - вызов `llama_numa_init(params.numa)`.
- `llama.cpp/src/llama.cpp` и `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - передача NUMA-стратегии в CPU backend и применение affinity.
