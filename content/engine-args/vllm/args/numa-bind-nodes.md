---
schema: 1
engine: vllm
primaryName: "--numa-bind-nodes"
title: "--numa-bind-nodes"
summary: Явный список NUMA-узлов, по одному на видимую карту, вместо автоопределения топологии. Обязателен везде, где автоопределение не работает: односокетный хост, отсутствие NVML, уже суженный CPU-affinity.
group: ParallelConfig
related:
  - --numa-bind
  - --numa-bind-cpus
  - --tensor-parallel-size
  - --data-parallel-size
  - --device-ids
---

# --numa-bind-nodes

## Кратко

`--numa-bind-nodes` перечисляет NUMA-узлы **по одному на видимую карту, в порядке индексов карт**. Значения уходят прямо в `numactl --cpunodebind=<node> --membind=<node>` для каждого worker-подпроцесса, а для процесса `EngineCore` — в объединение узлов его DP-шарда.

Флаг работает только вместе с `--numa-bind` и отменяет автоопределение топологии GPU→NUMA. Это единственный способ включить привязку там, где автоопределение отказывается: односокетная машина, отсутствующий NVML, уже суженный извне CPU-affinity.

## Оригинальная справка

```text
NUMA node to bind each GPU worker to.

Specify one NUMA node per visible GPU, for example `[0, 0, 1, 1]`
for a 4-GPU system with GPUs 0-1 on NUMA node 0 and GPUs 2-3 on
NUMA node 1. If unset and `numa_bind=True`, vLLM auto-detects the
GPU-to-NUMA topology. The values are passed to `numactl --membind`
and `--cpunodebind`, so they must be valid `numactl` NUMA node indices.
```

## Паспорт аргумента

- Флаги: `--numa-bind-nodes`
- Группа argparse: `ParallelConfig`
- Тип значения: список целых (`list[int] | None`)
- Допустимые значения: непустой список неотрицательных целых; `choices` нет — валидность индексов проверяет `numactl`
- Значение по умолчанию: `None` (автоопределение при `--numa-bind`)
- Эффективное значение: при `None` и `numa_bind=True` список **записывается обратно в конфиг** результатом автоопределения (`_get_numa_node` присваивает `parallel_config.numa_bind_nodes`), поэтому в рантайме поле почти никогда не остаётся пустым. Поле исключено из `ParallelConfig.compute_hash` — иначе DP-ранги с автоопределением расходились бы по хешу
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.numa_bind_nodes`
- Этап применения: порождение подпроцессов `EngineCore` и worker'ов — до импорта torch в ребёнке

## Что меняет в движке

`_get_numa_node(parallel_config, gpu_index)` берёт `numa_bind_nodes[gpu_index]`, где `gpu_index` — это `local_rank + dp_local_rank × pipeline_parallel_size × tensor_parallel_size` для не-Ray executor'а на одном узле и просто `local_rank` в остальных случаях. Отсюда требование «по одному значению на каждую видимую карту»: список короче — `ValueError: GPU index N exceeds numa_bind_nodes size M. Ensure the binding lists cover every visible GPU.`

Для `EngineCore` используется `_get_enginecore_numa_nodes`: берётся срез списка, соответствующий DP-шарду (`[dp_local_rank × pp × tp, +pp × tp)`), из него — отсортированное множество уникальных узлов, и все они уходят в `--cpunodebind`/`--membind` через запятую. Так EngineCore гарантированно оказывается надмножеством своих worker'ов.

Валидатор поля (`_validate_numa_bind_nodes`) отвергает пустой список и отрицательные значения. Существование узла не проверяется — это делает уже `numactl`.

## Значения и формат

- Список целых, в CLI пишется через пробел: `--numa-bind-nodes 0 0 1 1`.
- `FlexibleArgumentParser` принимает и точечно-подставляемые формы из `--config file.yaml`; при конфликте выигрывает явный флаг командной строки.
- Пустой список запрещён (`numa_bind_nodes must not be empty.`), отрицательные числа запрещены (`numa_bind_nodes must contain non-negative integers.`).
- Порядок — по индексам видимых карт (то есть после применения `CUDA_VISIBLE_DEVICES` или `--device-ids`), а не по физическим id.
- `None` (не задан) означает «определи сам», а не «не привязывать»: при `--numa-bind` без списка движок либо определит топологию, либо упадёт.

## Когда использовать

- **Автоопределение отказалось.** Любой из случаев: односокетный хост (`/sys/devices/system/node/node1` отсутствует), NVML не отдаёт NUMA-узел карты, CPU-affinity процесса уже сужен, нет прав на `get_mempolicy`.
- **Нужна раскладка, отличная от «ближайший узел».** Например, вы сознательно разводите два инстанса по разным сокетам, невзирая на PCIe-локальность.
- **Воспроизводимость конфигурации.** Автоопределение зависит от хоста; явный список делает запуск детерминированным.
- **Не задавайте список наугад.** Неверный узел не будет отвергнут валидатором: карта окажется привязана к дальнему сокету, и потери будут тихими. Топологию смотрите через `nvidia-smi topo -m` и `numactl --hardware`.

## Влияние на производительность и память

- **VRAM.** Не влияет.
- **RAM хоста.** `--membind` жёсткий: аллокации worker'а обязаны поместиться в память назначенного узла. При тесной раскладке это приводит к нехватке памяти вместо расселения по соседям.
- **Время старта.** Косвенно ускоряет загрузку весов на многосокетном хосте за счёт локальной памяти.
- **Throughput/latency.** Эффект тот же, что у `--numa-bind`; список лишь определяет, окажется ли привязка правильной.

## Взаимодействие с другими аргументами

- `--numa-bind`: обязателен. Без него — `numa_bind_nodes and numa_bind_cpus require numa_bind=True`.
- `--numa-bind-cpus`: при заданных обоих CPU берутся из `--numa-bind-cpus` (`--physcpubind`), а память — из `--numa-bind-nodes` (`--membind`).
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--data-parallel-size`: определяют число подпроцессов и формулу `gpu_index`, то есть требуемую длину списка.
- `--device-ids`, `CUDA_VISIBLE_DEVICES`: определяют, какие карты считаются видимыми и в каком порядке — список узлов идёт в том же порядке.
- NUMA-политика arriero (`instance.numa`, `docs/NUMA_PINNING.md` — документ arriero) действует на весь процесс инстанса и с этим списком не согласуется автоматически: если arriero уже сузил cpuset, значения `--numa-bind-nodes` вне cpuset просто не будут применены (`_resolve_numactl_args` деградирует до варианта без `--membind` или без привязки).

## Типовые проблемы и диагностика

- **Симптом:** `GPU index 3 exceeds numa_bind_nodes size 2. Ensure the binding lists cover every visible GPU.` **Причина:** длина списка меньше числа привязываемых карт. **Лечение:** дать ровно по одному значению на видимую карту.
- **Симптом:** `numa_bind_nodes and numa_bind_cpus require numa_bind=True.` **Лечение:** добавить `--numa-bind`.
- **Симптом:** `numa_bind_nodes must not be empty.` / `numa_bind_nodes must contain non-negative integers.` **Причина:** пустой или отрицательный ввод.
- **Симптом:** привязка «прошла», но производительность не изменилась. **Причина:** узлы указаны неверно либо `numactl` отверг аргументы. **Проверка:** лог `Binding worker subprocess (local_rank=..., gpu_index=...) to NUMA node N` и предупреждение `numactl args ... rejected; falling back to ...`; сверьте с `nvidia-smi topo -m`.
- **Подтверждение принятого значения:** при автоопределении в лог попадает `Auto-detected NUMA nodes for GPUs: [...]` — это ровно тот список, который вы могли бы записать в флаг.

## Примеры

```bash
vllm serve /models/Llama-3.1-8B-Instruct --tensor-parallel-size 4 --numa-bind --numa-bind-nodes 0 0 1 1
```

```bash
vllm serve /models/Llama-3.1-8B-Instruct --tensor-parallel-size 2 --numa-bind --numa-bind-nodes 1 1 --numa-bind-cpus 48-51 52-55
```

## Источники

- `vllm/vllm/utils/numa_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/docs/configuration/optimization.md`
- `docs/NUMA_PINNING.md` (arriero)
