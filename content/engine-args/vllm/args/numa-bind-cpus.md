---
schema: 1
engine: vllm
primaryName: "--numa-bind-cpus"
title: "--numa-bind-cpus"
summary: Точный CPU-список для каждой карты вместо привязки к NUMA-узлу целиком: vLLM переключается с `numactl --cpunodebind` на `--physcpubind`. Нужен, когда важен конкретный набор ядер, а не сокет.
group: ParallelConfig
related:
  - --numa-bind
  - --numa-bind-nodes
  - --tensor-parallel-size
  - --data-parallel-size
---

# --numa-bind-cpus

## Кратко

`--numa-bind-cpus` задаёт по одному `numactl`-списку CPU на видимую карту. Когда он задан, worker-подпроцессы запускаются с `--physcpubind=<список> --membind=<узел>` вместо `--cpunodebind=<узел> --membind=<узел>`: CPU выбираются точно, память по-прежнему привязывается к узлу из `--numa-bind-nodes` (или из автоопределения).

Флаг работает только вместе с `--numa-bind`. У него есть два неочевидных следствия: он **отключает** встроенную PCT-эвристику подбора приоритетных ядер и **не применяется** к процессу `EngineCore`.

## Оригинальная справка

```text
Optional CPU lists to bind each GPU worker to.

Specify one CPU list per visible GPU, for example
`["0-3", "4-7", "8-11", "12-15"]`. When set, vLLM uses
`numactl --physcpubind` instead of `--cpunodebind`. This is useful
for custom policies such as binding to PCT or other high-frequency cores.
Each entry must use `numactl --physcpubind` CPU-list syntax, for example
`"0-3"` or `"0,2,4-7"`.
```

## Паспорт аргумента

- Флаги: `--numa-bind-cpus`
- Группа argparse: `ParallelConfig`
- Тип значения: список строк (`list[str] | None`), каждая — CPU-список в синтаксисе `numactl --physcpubind`
- Допустимые значения: `choices` нет; формат проверяется регулярным выражением `^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$` плюс требование возрастания границ диапазона
- Значение по умолчанию: `None`
- Эффективное значение: при `None` vLLM может всё равно перейти на `--physcpubind`, если сработала PCT-эвристика для Granite Rapids Xeon; при заданном списке эвристика отключается. Поле исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.numa_bind_cpus`
- Этап применения: порождение worker-подпроцессов — до импорта torch в ребёнке

## Что меняет в движке

`_get_cpu_binding(parallel_config, gpu_index, numa_nodes)` возвращает `numa_bind_cpus[gpu_index]`, и `_get_numactl_worker_args` формирует `--physcpubind=<cpus> --membind=<node>`. Индекс карты вычисляется так же, как для `--numa-bind-nodes`: `local_rank + dp_local_rank × pipeline_parallel_size × tensor_parallel_size` (для не-Ray executor'а на одном узле). Список короче числа карт ⇒ `ValueError: GPU index N exceeds numa_bind_cpus size M. Ensure the binding lists cover every visible GPU.`

**EngineCore игнорирует этот флаг намеренно.** `_get_numactl_enginecore_args` объясняет причину: привязать EngineCore к любой из пользовательских записей значило бы сузить его `cpus_allowed` ниже строгого надмножества, которое требуется для порождения worker'ов с `--physcpubind`. Поэтому EngineCore всегда получает `--cpunodebind=<узлы шарда>`.

**PCT-эвристика.** Когда `--numa-bind-cpus` не задан, `_maybe_get_pct_cpu_binding` пытается вычислить приоритетные ядра Priority Core Turbo на известных SKU Granite Rapids (`6776P`, `6774P`, `6962P` в `_PCT_CAPABLE_SKUS`) по эвристике `cpu_id % stride ∈ {0, 1}` внутри cpulist узла, с проверкой `acpi_cppc/highest_perf` на cpu0. Если эвристика сработала, worker'ы всё равно получают `--physcpubind`. Задание `--numa-bind-cpus` этот путь выключает: ручная политика считается приоритетнее.

**Проба и деградация.** `_resolve_numactl_args` перед применением запускает `numactl <args> true`. Если аргументы отвергнуты, сначала пробуется вариант без `--membind`, затем запуск без привязки вообще, с предупреждением.

## Значения и формат

- Список строк, в CLI через пробел: `--numa-bind-cpus 0-3 4-7 48-51 52-55`.
- Синтаксис одной записи — `numactl --physcpubind`: `0-3`, `0,2,4-7`, `16-31,48-63`. Пробелы внутри записи недопустимы.
- Валидатор отвергает: пустой список (`numa_bind_cpus must not be empty.`), пустую запись (`numa_bind_cpus entries must not be empty.`), несоответствие формату (`numa_bind_cpus entries must use numactl CPU list syntax, for example '0-3' or '0,2,4-7'.`) и убывающий диапазон (`numa_bind_cpus ranges must be ascending, but got '7-4'.`).
- Существование указанных CPU и их принадлежность нужному узлу **не проверяются** — это забота `numactl` и ваша.
- `None` (не задан) означает «привязка по узлу целиком», а не «без привязки».

## Когда использовать

- **Нужен подмножественный набор ядер.** Например, оставить часть ядер сокета под другие процессы, или закрепить worker'ы за конкретными физическими ядрами без hyper-threading-близнецов.
- **Своя политика высокочастотных ядер.** Тот самый сценарий из справки: PCT или иные приоритетные ядра, если встроенная эвристика вашу платформу не распознаёт.
- **Хост делят несколько инстансов.** Явное разведение по CPU-спискам исключает конкуренцию за одни и те же ядра.
- **Не используйте, если достаточно узла.** `--cpunodebind` оставляет планировщику свободу внутри сокета; жёсткий `--physcpubind` при неверном подборе ядер легко делает хуже, чем автоматика.
- **Не пытайтесь этим флагом привязать EngineCore** — он его не читает.

## Влияние на производительность и память

- **VRAM.** Не влияет.
- **RAM хоста.** Косвенно: `--membind` берётся из узла, а не из этого списка, поэтому неудачная пара «CPU одного сокета, память другого» вполне выразима и даёт худший результат, чем отсутствие привязки.
- **Время старта.** Может ухудшиться: загрузка весов параллельна, и слишком узкий CPU-список ограничивает её. Помните, что `OMP_NUM_THREADS` считается от общего числа CPU и числа локальных worker'ов, а не от вашего списка.
- **Throughput/latency.** Выигрыш возможен на платформах с неоднородными ядрами; на однородном сокете обычно нулевой.

## Взаимодействие с другими аргументами

- `--numa-bind`: обязателен.
- `--numa-bind-nodes`: продолжает определять `--membind`, то есть узел памяти. Практически всегда задавать оба списка вместе, согласовав их между собой.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--data-parallel-size`: задают требуемую длину списка через формулу `gpu_index`.
- NUMA-политика arriero (`instance.numa`, `docs/NUMA_PINNING.md` — документ arriero): режим `bind` создаёт cpuset-cgroup на весь процесс инстанса, и `--physcpubind` вне этого cpuset применён не будет — `_resolve_numactl_args` тихо откатится. Совмещать два слоя не нужно: либо cpuset arriero на инстанс, либо per-GPU списки vLLM.

## Типовые проблемы и диагностика

- **Симптом:** `numa_bind_cpus entries must use numactl CPU list syntax, for example '0-3' or '0,2,4-7'.` **Причина:** пробел, лишний символ или неверный разделитель в записи.
- **Симптом:** `numa_bind_cpus ranges must be ascending, but got '7-4'.` **Лечение:** записать диапазон по возрастанию.
- **Симптом:** `GPU index 3 exceeds numa_bind_cpus size 2. Ensure the binding lists cover every visible GPU.` **Лечение:** дать ровно по одной записи на видимую карту.
- **Симптом:** worker'ы стартуют, но привязки нет; в логе `numactl args '--physcpubind=0-3 --membind=0' rejected; falling back to 'no binding'.` **Причина:** указанные CPU недоступны процессу (внешний cpuset/контейнер) либо нет прав на политику памяти. **Лечение:** привести список в соответствие с реально доступными CPU, добавить `--cap-add SYS_NICE` в контейнере.
- **Подтверждение принятого значения:** `Binding worker subprocess (local_rank=..., gpu_index=...) to CPUs 0-3 and NUMA node 0`. Если вы флаг не задавали, а строка всё равно про CPU — сработала PCT-эвристика, о чём есть отдельная строка `Detected PCT-capable Granite Rapids Xeon (stride=...)`.

## Примеры

```bash
vllm serve /models/Llama-3.1-8B-Instruct --tensor-parallel-size 4 --numa-bind --numa-bind-nodes 0 0 1 1 --numa-bind-cpus 0-3 4-7 48-51 52-55
```

```bash
vllm serve /models/Llama-3.1-8B-Instruct --tensor-parallel-size 2 --numa-bind --numa-bind-nodes 0 0 --numa-bind-cpus 0,2,4-7 8,10,12-15
```

## Источники

- `vllm/vllm/utils/numa_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/docs/configuration/optimization.md`
- `docs/NUMA_PINNING.md` (arriero)
