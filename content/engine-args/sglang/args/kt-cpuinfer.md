---
schema: 1
engine: sglang
primaryName: "--kt-cpuinfer"
title: "--kt-cpuinfer"
summary: Общее число рабочих потоков CPU-движка KTransformers; они распределяются по пулам `--kt-threadpool-count` и жестко прикрепляются к ядрам внутри своих NUMA-узлов. Ставится по числу физических ядер, не потоков SMT.
group: exec.moe
related:
  - --kt-threadpool-count
  - --kt-weight-path
  - --kt-num-gpu-experts
  - --numa-node
---

# --kt-cpuinfer

## Кратко

`--kt-cpuinfer` — суммарное количество потоков, которые kt-kernel создаст для счета экспертов на CPU. Значение делится между пулами (`--kt-threadpool-count`), каждый пул поднимается на своем NUMA-узле, а каждый поток внутри пула прибивается к отдельному физическому ядру через hwloc. Пул создается один раз — на первом MoE-слое — и дальше переиспользуется всеми слоями, поэтому подобрать значение «по слоям» невозможно.

## Оригинальная справка

```text
[ktransformers parameter] The number of CPUInfer threads.
```

## Паспорт аргумента

- Флаги: `--kt-cpuinfer`
- Группа: `exec.moe`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: не ограничены на уровне argparse; смысл имеют значения от 1 до числа физических ядер, доступных процессу
- Значение по умолчанию: `null` — SGLang ничего не подставляет
- Эффективное значение: не переопределяется; `ServerArgs.__post_init__` это поле не читает. При включенном KT (`--kt-weight-path` задан) незаданное значение уходит в kt-kernel как `None` и попадает в целочисленное деление `cpuinfer_threads // threadpool_count` (`_get_cpu_infer` в `ktransformers/kt-kernel/python/experts_base.py`) — то есть значение обязано быть задано явно
- Где объявлен: `ServerArgs.kt_cpuinfer`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, реализация целиком во внешнем пакете `kt_kernel`
- Этап применения: создание синглтона `CPUInfer` при инициализации первого MoE-слоя

## Что меняет в движке

Значение проходит `KTConfig.cpuinfer_threads` → `KTMoEWrapper(cpuinfer_threads=…)` → `BaseMoEWrapper._get_cpu_infer(...)`, где строится `WorkerPoolConfig`:

- `subpool_count = threadpool_count`;
- `subpool_numa_map = [0, 1, …, threadpool_count-1]` (в апстрим-SGLang явный список узлов не передается — `numa_nodes` остается `None`);
- `subpool_thread_count[i] = cpuinfer_threads // threadpool_count + (1 if i < cpuinfer_threads % threadpool_count else 0)` — остаток от деления достается первым пулам.

`WorkerPool::init` (`ktransformers/kt-kernel/cpu_backend/worker_pool.cpp`) на каждый подпул выполняет `set_to_numa(node)` и создает `InNumaPool` с этим числом потоков. Внутри пула поток с индексом 0 — это вызывающий поток, остальные `N-1` спавнятся отдельно, получают имена `numa_<node>_t_<idx>` и через hwloc прикрепляются к конкретному ядру внутри узла (`hwloc_bitmap_singlify` + `HWLOC_CPUBIND_STRICT`).

Пул — синглтон уровня класса (`_cpu_infer_instance`): значения, с которыми он создан на первом слое, действуют для всей модели.

Простаивающий поток крутится в активном ожидании до 50 мс после последней задачи и лишь затем засыпает на condition variable. Практически это значит: во время генерации все `--kt-cpuinfer` ядер заняты полностью, между запросами загрузка спадает примерно через 50 мс.

## Значения и формат

- Целое число. Значение — общее по всему процессу, а не «на пул»: деление на пулы делает kt-kernel.
- Официальная рекомендация KTransformers — число **физических** ядер, не гипертредов: `физические ядра = CPU(s) / Thread(s) per core` из `lscpu`. README kt-kernel отдельно предупреждает, что установка по числу гипертредов деградирует производительность.
- Значение больше, чем ядер в узле, не приводит к ошибке: hwloc не найдет ядро с нужным индексом, напечатает в stderr `Core <i> inside NUMA node <n> not found` и оставит поток непривязанным. То есть перебор проявляется как деградация и шум в логе, а не как отказ старта.
- Значение не делится нацело на число пулов — это допустимо, остаток распределяется по первым пулам.
- `0` или отрицательное значение argparse примет, а kt-kernel создаст пул без рабочих потоков; в arriero такое отсекает preflight.

## Когда использовать

- Задавайте всегда, когда задан `--kt-weight-path`: разумного дефолта нет.
- Оставляйте запас, если на том же хосте живут другие процессы: потоки KT занимают ядра целиком и на все время генерации.
- Не увеличивайте значение выше физических ядер в попытке «занять гипертреды» — по документации kt-kernel это ухудшает результат, а привязка к ядрам просто перестанет работать.
- Не пытайтесь снизить нагрузку на CPU уменьшением `--kt-cpuinfer`, если проблема в объеме CPU-работы: правильная ручка — увеличить `--kt-num-gpu-experts`.

## Влияние на производительность и память

- Пропускная способность CPU-части почти линейна по числу потоков до упора в память: AMX/AVX-ядра kt-kernel считают эксперты блоками с work stealing внутри пула.
- На RAM аргумент влияет слабо: буферы под активации выделяются по `chunked_prefill_size` и размеру батча, а не по числу потоков. Основной вклад в RAM дают веса из `--kt-weight-path`.
- На VRAM не влияет.
- Время старта растет незначительно (создание потоков), основное время загрузки — чтение весов.
- CPU-часть **не** масштабируется тензорным параллелизмом: `KTEPWrapperMethod` создает CPU-обертку только на `tp_rank == 0`, а `moe_intermediate_size` передает полным (`intermediate_size_per_partition * moe_tp_size`). При `--tp-size 8` вся CPU-работа по-прежнему выполняется одним набором из `--kt-cpuinfer` потоков.

## Взаимодействие с другими аргументами

- `--kt-threadpool-count`: делитель. Пара задает раскладку «сколько потоков на каком узле».
- `--kt-weight-path`: без него значение не читается вообще.
- `--kt-num-gpu-experts`: определяет, сколько работы вообще достанется этим потокам. Чем больше экспертов на GPU, тем менее чувствительно значение `--kt-cpuinfer`.
- `--kt-max-deferred-experts-per-token`: сдвигает часть CPU-работы в конвейер со следующим слоем; при насыщенном CPU эффект заметнее.
- `--numa-node` (аргумент SGLang для привязки подпроцессов) — другой слой: он про размещение процессов SGLang, а не про внутренние пулы kt-kernel. Не путайте их и не пытайтесь заменить одно другим.
- В arriero NUMA-режим инстанса — внешняя изоляция. Режим `interleave` для KTransformers запрещен preflight'ом, а внешний `bind` обязан совпадать со всеми внутренними узлами KT (`docs/NUMA_PINNING.md`, `docs/KTRANSFORMERS_OPERATIONS.md`); при bind в cpuset попадают только ядра одного узла, и потоков сверх этого набора привязать не удастся.

## Типовые проблемы и диагностика

- Старт падает с `TypeError` в `_get_cpu_infer` — значение не задано, а KT включен. Задайте `--kt-cpuinfer` явно.
- В stderr много строк `Core <i> inside NUMA node <n> not found` — потоков запрошено больше, чем ядер в узле, часть работает без привязки. Уменьшите значение или увеличьте `--kt-threadpool-count`.
- Раскладку по факту подтверждает первая строка `WorkerPool[0x…] N subpools, [numa:threads][0:32] [1:32]` и следом `In Numa Worker Pool at NUMA <node>, <threads> threads`. Значение аргумента как его принял SGLang — в дампе `server_args=` при старте.
- Фактическую привязку потоков к узлам удобно проверять по именам задач процесса (`numa_<node>_t_<idx>` в `/proc/<pid>/task/*/comm`) — это же требуется в апгрейд-гейте arriero.
- CPU не загружен, генерация медленная — проверьте, что эксперты вообще попадают на CPU: при слишком большом `--kt-num-gpu-experts` CPU-часть почти пуста.
- В arriero preflight отклоняет неположительные значения и значения больше числа физических ядер, доступных менеджеру, и выдает предупреждение при расхождении с их числом на 25% и больше.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-INT8 --kt-method AMXINT8 --kt-cpuinfer 64 --kt-threadpool-count 2 --kt-num-gpu-experts 32
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-Q4_K_M --kt-method LLAMAFILE --kt-cpuinfer 8 --kt-threadpool-count 1 --kt-num-gpu-experts 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `ktransformers/kt-kernel/python/experts_base.py`
- `ktransformers/kt-kernel/cpu_backend/worker_pool.cpp`
- `ktransformers/kt-kernel/README.md`
- `ktransformers/doc/en/AMX.md`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/NUMA_PINNING.md`
