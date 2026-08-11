---
schema: 1
engine: vllm
primaryName: "--numa-bind"
title: "--numa-bind"
summary: Оборачивает GPU-подпроцессы vLLM (worker'ы и EngineCore) в `numactl` до старта интерпретатора, привязывая их к NUMA-узлу ближайшему к своей карте. Только для многосокетных хостов; на UMA-машине без явного `--numa-bind-nodes` старт падает.
group: ParallelConfig
related:
  - --numa-bind-nodes
  - --numa-bind-cpus
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --data-parallel-size
  - --distributed-executor-backend
---

# --numa-bind

## Кратко

`--numa-bind` включает привязку GPU-подпроцессов vLLM к NUMA-узлу. Привязка ставится **до** запуска Python: движок подменяет `multiprocessing.spawn.set_executable` на скрипт-обёртку, который запускает интерпретатор через `numactl`. Поэтому импорт torch, аллокатор и pinned-буферы с самого начала создаются с нужной политикой памяти.

По умолчанию для каждого worker'а vLLM сам определяет NUMA-узел его карты (через NVML) и ставит `--cpunodebind=<node> --membind=<node>`.

Флаг относится **только к GPU-процессам исполнения** — worker'ам и `EngineCore`. Фронтенд-процессы API-сервера и DP-координатор не привязываются, а CPU-backend настраивается совсем другим механизмом (`VLLM_CPU_OMP_THREADS_BIND`).

Это собственная NUMA-политика движка. В arriero есть своя, независимая (`docs/NUMA_PINNING.md`) — их границы разведены в разделе про взаимодействие.

## Оригинальная справка

```text
Enable NUMA binding for GPU worker subprocesses.

By default, workers are pinned to their GPU's NUMA-local CPUs and
memory; on PCT-capable Xeons they also auto-bind to the SKU's
PCT priority cores.
```

## Паспорт аргумента

- Флаги: `--numa-bind`, `--no-numa-bind`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-numa-bind` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: остаётся заданным, но привязка может быть **тихо снята** в рантайме: `_resolve_numactl_args` пробует `numactl <args> true` и при отказе сначала выбрасывает `--membind`, затем отказывается от привязки вовсе; при `VLLM_WORKER_MULTIPROC_METHOD != spawn` привязка не применяется с предупреждением. Значение исключено из `ParallelConfig.compute_hash` (не влияет на семантику коллективов)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.numa_bind`
- Этап применения: порождение подпроцессов (`EngineCore` в `vllm/v1/engine/utils.py`, worker'ы в `vllm/v1/executor/multiproc_executor.py`) — до импорта torch в ребёнке

## Что меняет в движке

Точка входа — контекстный менеджер `numa_utils.configure_subprocess(vllm_config, local_rank, dp_local_rank, process_kind)`. При `numa_bind=False` он ничего не делает.

**Для worker'а** (`process_kind="worker"`) `_get_numactl_worker_args` вычисляет индекс карты (`local_rank + dp_local_rank × pp × tp`, если executor не Ray и узел один), берёт для него NUMA-узел и формирует либо `--cpunodebind=<node> --membind=<node>`, либо — если задан `--numa-bind-cpus` или сработала PCT-эвристика — `--physcpubind=<cpus> --membind=<node>`.

**Для EngineCore** (`process_kind="EngineCore"`) `_get_numactl_enginecore_args` берёт **объединение** узлов своего DP-шарда и всегда использует `--cpunodebind`, даже если задан `--numa-bind-cpus`: EngineCore обязан быть надмножеством по `cpus_allowed` относительно своих worker'ов, иначе их `--physcpubind` не запустится.

**Автоопределение узлов.** `get_auto_numa_nodes()` работает только при выполнении всех условий `_is_auto_numa_available()`:

- платформа CUDA-подобная;
- существует `/sys/devices/system/node/node1`, то есть узлов больше одного;
- у процесса **не сужен** CPU-affinity (иначе лог `CPU affinity is already constrained for this process. Skipping automatic NUMA binding; pass --numa-bind-nodes explicitly to override.`);
- доступны syscall'ы политики памяти (`get_mempolicy`), иначе `User lacks permission to set NUMA memory policy. ... try adding --cap-add SYS_NICE.`;
- платформа реализует `get_all_device_numa_nodes`.

Если автоопределение не удалось, а `--numa-bind-nodes` не задан, `_get_numa_node` бросает `RuntimeError: NUMA binding was requested, but vLLM could not detect the GPU-to-NUMA topology automatically. Pass --numa-bind-nodes explicitly or disable --numa-bind.`

**PCT-эвристика.** На Granite Rapids Xeon из списка `_PCT_CAPABLE_SKUS` (6776P, 6774P, 6962P) с совпавшим `acpi_cppc/highest_perf` vLLM дополнительно вычисляет «приоритетные» ядра (`cpu_id % stride ∈ {0, 1}` внутри cpulist узла) и привязывает к ним через `--physcpubind`. Это работает **только** когда `--numa-bind-cpus` не задан. В логе: `Detected PCT-capable Granite Rapids Xeon (stride=%d); NUMA node %d priority cores: ...`.

**Требования среды.** Нужен `numactl` в `PATH`, иначе `RuntimeError: numactl is required for NUMA binding but is not installed or not available on PATH.` Нужен метод старта `spawn`; CLI `vllm serve` выставляет `VLLM_WORKER_MULTIPROC_METHOD=spawn`, если переменная не задана.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- `--no-numa-bind` — явное подтверждение дефолта.
- Без этого флага `--numa-bind-nodes` и `--numa-bind-cpus` запрещены: `numa_bind_nodes and numa_bind_cpus require numa_bind=True`.
- Флаг не имеет отношения к CPU-backend'у vLLM: там работают `VLLM_CPU_OMP_THREADS_BIND`, `VLLM_CPU_NUM_OF_RESERVED_CPU`, `CPU_VISIBLE_MEMORY_NODES`.

## Когда использовать

- **Многосокетный GPU-хост.** Карты висят на разных корневых комплексах; без привязки поток worker'а и его host-память могут оказаться на «чужом» узле, и весь трафик host↔device идёт через межсокетный линк.
- **Заметны провалы на загрузке весов и на H2D-копиях.** Это первое, что чувствуется от неверной локальности.
- **Не включайте на односокетной (UMA) машине.** Пользы нет по определению, а автоопределение на такой машине не работает (нет `node1`) и старт упадёт `RuntimeError`, если не задать `--numa-bind-nodes` вручную.
- **Не включайте, если процесс уже привязан снаружи** (cpuset-cgroup, `taskset`, `numactl` от супервизора): автоопределение откажется работать и напишет об этом в лог. Либо снимите внешнюю привязку, либо задайте `--numa-bind-nodes` явно.

## Влияние на производительность и память

- **VRAM.** Не влияет: привязка касается CPU и host-памяти.
- **RAM хоста.** Меняет **место** аллокации, а не объём. При `--membind` попытка выйти за память узла заканчивается не расселением по соседям, а нехваткой памяти — на узком узле это реальный риск.
- **Время старта.** Может заметно сократиться на многосокетных машинах: загрузка весов и pinned-буферы получают локальную память. `numactl --show`-проба (`_probe_numactl_args`) добавляет к старту три коротких запуска процесса, не больше.
- **Throughput/latency.** Выигрыш идёт от локальности host-памяти и стабильности планирования потоков; на однопроцессорной машине эффекта нет.

## Взаимодействие с другими аргументами

- `--numa-bind-nodes`: задаёт список узлов вручную, по одному на видимую карту; отменяет автоопределение.
- `--numa-bind-cpus`: переключает worker'ов с `--cpunodebind` на `--physcpubind` и отключает PCT-эвристику; для EngineCore игнорируется намеренно.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--data-parallel-size`: определяют, сколько worker-подпроцессов будет привязано и как считается индекс карты (`local_rank + dp_local_rank × pp × tp`).
- `--distributed-executor-backend`: при `ray`/`external_launcher` (или `--data-parallel-backend ray`) индекс карты берётся как `local_rank` без DP-смещения.

### Граница с NUMA-политикой arriero

arriero имеет собственный слой NUMA (`docs/NUMA_PINNING.md` — документ arriero), и он **не** тот же самый:

- **Что делает arriero.** `instance.numa` — это `{mode:"bind", node}` (cpuset-cgroup v2 на весь процесс инстанса, жёсткий потолок по `cpuset.cpus`/`cpuset.mems`) или `{mode:"interleave", nodes}` (обёртка `numactl --interleave`). Политика применяется к **корневому процессу** `vllm serve`, и все его потомки её наследуют. На односокетном хосте она инертна.
- **Что делает vLLM.** `--numa-bind*` привязывает **отдельные подпроцессы** (`EngineCore` и worker'ы) каждый к своему узлу — по карте, а не по инстансу. arriero про эти подпроцессы ничего не знает.
- **Что происходит при совмещении.** Режим arriero `bind` сужает `cpus_allowed` всего дерева, и `_is_auto_numa_available()` это видит: автоопределение отключается с сообщением `CPU affinity is already constrained for this process`. Дальше `_get_numa_node` бросает `RuntimeError`, если `--numa-bind-nodes` не задан явно. Даже с явным списком `numactl --cpunodebind`/`--physcpubind` за пределы cpuset выйти не сможет; `_resolve_numactl_args` в этом случае тихо деградирует до варианта без `--membind` или без привязки вообще.
- **Практический вывод.** Для многокарточного vLLM на многосокетном хосте выбирайте один слой. Либо один узел на весь инстанс средствами arriero (`bind`) — тогда vLLM-привязка избыточна и мешает автоопределению. Либо per-GPU привязка средствами vLLM — тогда `instance.numa` в arriero не задавайте.

## Типовые проблемы и диагностика

- **Симптом:** `NUMA binding was requested, but vLLM could not detect the GPU-to-NUMA topology automatically. Pass --numa-bind-nodes explicitly or disable --numa-bind.` **Причина:** односокетный хост, недоступный NVML, суженный affinity или отсутствие прав на политику памяти. **Лечение:** задать `--numa-bind-nodes` или убрать флаг.
- **Симптом:** `numactl is required for NUMA binding but is not installed or not available on PATH.` **Лечение:** установить `numactl` в окружение, из которого запускается сервер.
- **Симптом:** `NUMA binding requires spawn method but got 'fork'. NUMA binding will be ineffective.` **Причина:** `VLLM_WORKER_MULTIPROC_METHOD=fork`. **Лечение:** `VLLM_WORKER_MULTIPROC_METHOD=spawn`.
- **Симптом:** `numactl args '--cpunodebind=1 --membind=1' rejected; falling back to '--cpunodebind=1'. Add --cap-add SYS_NICE for full NUMA binding.` **Причина:** контейнер не даёт менять политику памяти. **Лечение:** добавить capability `SYS_NICE`.
- **Симптом:** `User lacks permission to set NUMA memory policy. Automatic NUMA detection may not work; if you are using Docker, try adding --cap-add SYS_NICE.` — то же самое, но на этапе автоопределения.
- **Подтверждение принятого значения:** строки `Auto-detected NUMA nodes for GPUs: [...]` и `Binding worker subprocess (local_rank=..., gpu_index=...) to NUMA node N` / `Binding EngineCore subprocess (local_rank=...) to NUMA nodes N`. На уровне DEBUG дополнительно печатается `numactl --show` каждого процесса (`Worker_<rank> affinity: ...`).

## Примеры

```bash
vllm serve /models/Llama-3.1-8B-Instruct --tensor-parallel-size 4 --numa-bind
```

```bash
vllm serve /models/Llama-3.1-8B-Instruct --tensor-parallel-size 4 --numa-bind --numa-bind-nodes 0 0 1 1
```

## Источники

- `vllm/vllm/utils/numa_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/docs/configuration/optimization.md`
- `docs/NUMA_PINNING.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
