---
schema: 1
engine: sglang
primaryName: "--numa-node"
title: "--numa-node"
summary: Явная привязка scheduler-подпроцессов к NUMA-узлам вместо автоопределения по аффинности GPU. Список индексируется идентификатором карты, а не порядковым номером процесса.
group: device
related:
  - --base-gpu-id
  - --gpu-id-step
  - --tp-size
  - --device
  - --kt-threadpool-count
  - --kt-cpuinfer
  - --use-ray
---

# --numa-node

## Кратко

`--numa-node` задает, к какому NUMA-узлу привязать CPU и память каждого scheduler-подпроцесса. Без аргумента SGLang сам спрашивает у NVML, с каким узлом аффинна карта ранга, и привязывается туда — на большинстве двухсокетных хостов этого достаточно. Аргумент нужен, когда автоопределение недоступно (нет `pynvml`, нет прав на `set_mempolicy`) или когда его выбор надо переопределить. Главная ловушка: **список индексируется значением `gpu_id`, а не номером подпроцесса**, вопреки формулировке справки.

Этот аргумент управляет только внутренними процессами движка. Он не пересекается ни с NUMA-политикой инстанса arriero (`docs/NUMA_PINNING.md`), ни с пулами потоков KTransformers (`--kt-threadpool-count`) — границы разобраны ниже.

## Оригинальная справка

```text
Sets the numa node for the subprocesses. i-th element corresponds to i-th subprocess. If unset, will be automatically detected on NUMA systems.
```

## Паспорт аргумента

- Флаги: `--numa-node`
- Группа: `device`
- Тип значения: список int (`Optional[List[int]]`, argparse `nargs="+"` — значения разделяются пробелами)
- Допустимые значения: `choices` нет, диапазон не проверяется. Индекс должен существовать в `/sys/devices/system/node/`; несуществующий узел приведет к отказу `numactl` и предупреждению, а не к ошибке старта
- Значение по умолчанию: `null` — «определить автоматически»
- Эффективное значение: при `null` — результат `_query_numa_node_for_gpu(gpu_id)` через `pynvml.nvmlDeviceGetMemoryAffinity`, и только если `_is_numa_available()` вернул True. Явно заданный список **не** проверяется на длину и не сверяется с топологией
- Где объявлен: `ServerArgs.numa_node`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: непосредственно перед `proc.start()` каждого scheduler-процесса (`numa_utils.configure_subprocess`) либо в самом процессе (`configure_scheduler_process`), в зависимости от `SGLANG_NUMA_BIND_V2`

## Что меняет в движке

### Что именно индексируется

Единственная точка чтения — `get_numa_node_if_available(server_args, gpu_id)` (`sglang/python/sglang/srt/utils/numa_utils.py`):

```python
if server_args.numa_node is not None:
    return server_args.numa_node[gpu_id]
```

Ключ — `gpu_id`, то есть результат формулы `base_gpu_id + … + tp_rank * gpu_id_step`. При `--base-gpu-id 2 --tensor-parallel-size 2` обращения пойдут к элементам `[2]` и `[3]`, и список из двух элементов даст `IndexError` в родительском процессе на старте. Список должен покрывать весь диапазон используемых `gpu_id`, включая пропущенные при `--gpu-id-step > 1` позиции (значения в «дырках» не читаются, но места занимать обязаны).

### Два пути привязки

- **V2 (по умолчанию, `SGLANG_NUMA_BIND_V2=True`).** `configure_subprocess` формирует аргументы `numactl` (`--cpunodebind=N --membind=N`, либо `--physcpubind=<список> --membind=N`, если текущая affinity процесса покрывает узел не целиком), проверяет их сухим прогоном `numactl … true` и подменяет `multiprocessing.spawn` executable на shell-обертку `exec numactl … python "$@"`. Привязка действует с первой инструкции интерпретатора, до импорта torch и до первого выделения памяти.
- **V1 (`SGLANG_NUMA_BIND_V2=0`).** Уже внутри scheduler-процесса `configure_scheduler_process` вызывает `numa_bind_to_node(node)`: пересечение CPU узла с текущей affinity через `os.sched_setaffinity` плюс `numa_set_preferred`. Мягче: политика памяти — «предпочтительно», а не «строго».
- Под `--use-ray` numactl-обертка неприменима (актор запускает не мы), поэтому `SchedulerActor` всегда делает in-process `numa_bind_to_node`.

### Деградация вместо отказа

Если строгая привязка не проходит, `_probe_numactl_args` последовательно ослабляет ее: `--membind=N` → `--preferred=N` → только CPU-привязка. Каждая ступень пишет `warning` с текстом отказа `numactl`. Если не проходит даже CPU-привязка, `_handle_numa_bind_failure` пишет предупреждение и запуск продолжается **без** привязки; сделать это фатальным можно переменной `SGLANG_CRASH_ON_NUMA_BIND_FAILURE=1`.

### Когда автоопределение вообще не включается

`_is_numa_available()` возвращает False (и привязки не будет) при любом из условий: сборка не CUDA; нет каталога `/sys/devices/system/node/node1` (одноузловой хост); нет `numactl` в PATH при V2; `get_mempolicy(2)` недоступен — тогда в лог идет `User lacks permission to set NUMA affinity, skipping NUMA node configuration for GPU. If using docker, try adding --cap-add SYS_NICE …`. Отсутствие `pynvml` дает отдельное предупреждение `pynvml not installed, skipping NUMA node configuration for GPU`. **Явно заданный `--numa-node` эти проверки обходит** — он идет сразу в построение аргументов `numactl`.

## Значения и формат

- Пробел-разделенный список целых: `--numa-node 0 0 1 1`. Запятые не поддерживаются — argparse отдаст `invalid int value`.
- Длина списка должна покрывать максимальный используемый `gpu_id + 1`, а не число рангов.
- Индексы — узлы ядра (`lscpu | grep "NUMA node(s)"`, `/sys/devices/system/node/`), а не сокеты: NPS/SNC делят один процессор на несколько узлов.
- Повторы допустимы и нормальны: несколько рангов на одном узле — обычная конфигурация.
- Специальных значений нет; `-1` не означает «не привязывать» — он просто не найдется как узел, и `numactl` откажет.
- На одноузловой (UMA) машине аргумент бессмыслен: привязывать не к чему.

## Когда использовать

- Двухсокетный хост, где автоопределение не работает (контейнер без `SYS_NICE`, отсутствует `pynvml`) — задайте список вручную, взяв аффинность из `nvidia-smi topo -m` (столбец `NUMA Affinity`).
- Нужно осознанно нарушить аффинность: например, разнести два экземпляра по узлам, чтобы не делить пропускную способность памяти, даже ценой лишнего хопа до карты.
- Не трогайте на односокетной машине и на CPU-инференсе (`--device cpu`): там CPU-потоки распределяет `SGLANG_CPU_OMP_THREADS_BIND`, а не этот аргумент.
- Не используйте как замену планированию памяти: привязка `--membind` — жесткий потолок, и превышение свободной памяти узла даст OOM.

### Где кончается ответственность каждого слоя

- **`--numa-node` (этот аргумент)** — привязка python-процессов scheduler'ов SGLang: их CPU и их аллокации, включая KV-пул на хосте и буферы обмена. По одному значению на GPU.
- **NUMA-политика инстанса arriero** (`instance.numa`, `docs/NUMA_PINNING.md`) — внешняя по отношению к движку: либо cgroup-cpuset (`mode: "bind"`, жесткая изоляция CPU и памяти всего дерева процессов), либо запуск под `numactl --interleave` (`mode: "interleave"`). Она применяется к процессу до того, как движок вообще прочитал свои аргументы, и сужает ту самую `os.sched_getaffinity`, из которой `_numactl_cpu_mem_args` считает пересечение. Если внутренний и внешний слои противоречат друг другу, пересечение окажется пустым и в лог пойдет `NUMA node N has no CPU cores allowed by the current affinity …`. Preflight KTransformers в arriero прямо запрещает менеджерский `interleave` для этого движка и требует, чтобы менеджерский `bind` совпадал с внутренними узлами KTransformers.
- **Пулы потоков KTransformers** (`--kt-threadpool-count`, `--kt-cpuinfer`, а в форк-сборке `sglang-kt` еще и `--kt-numa-nodes`, которого в апстрим-исходниках нет) — это привязка **рабочих потоков внутри процесса** и раскладка весов экспертов по узлам, выполняемая kt-kernel через `set_to_numa`. Она не отменяет и не заменяет `--numa-node`: та определяет, где живет процесс, эта — где живут CPU-эксперты. Подробности — в `kt-threadpool-count.md`.

## Влияние на производительность и память

- RAM хоста: при `--membind` аллокации процесса ограничены памятью одного узла. Это и есть цель (локальность), и это же риск — превышение узла дает OOM вместо прозрачного расползания по хостовой памяти.
- Пропускная способность памяти: правильная привязка убирает межсокетные обращения на пути «CPU → память → PCIe → GPU»; на больших prefill и на CPU-оффлоаде разница измерима.
- VRAM: не затрагивается.
- Время старта: добавляется несколько запусков `numactl … true` (проба, таймаут 10 с каждая) в родительском процессе на каждый ранг. На практике доли секунды.
- Latency: заметный эффект только на многосокетных хостах и при значительной CPU-части нагрузки.

## Взаимодействие с другими аргументами

- `--base-gpu-id` / `--gpu-id-step`: определяют, какие именно индексы списка будут прочитаны. Это единственная причина, по которой список бывает длиннее числа рангов.
- `--tp-size` / `--pp-size` / `--dp-size`: задают число подпроцессов, каждый из которых получит свое значение по своему `gpu_id`.
- `--use-ray`: привязка выполняется in-process (`numa_bind_to_node`), а не через `numactl`, — политика памяти получается мягче (`numa_set_preferred`).
- `--device`: автоопределение работает только на CUDA; на прочих устройствах привязка возможна только явным списком.
- `--kt-threadpool-count` / `--kt-cpuinfer`: соседний, независимый слой (см. выше). Согласовывать значения нужно вручную — движок этого не делает.

## Типовые проблемы и диагностика

- `IndexError: list index out of range` при запуске scheduler-процессов — список короче, чем используемые `gpu_id`. Считайте максимальный индекс по формуле из `base-gpu-id.md`, а не по числу рангов.
- `NUMA node N has no CPU cores allowed by the current affinity [...], skipping NUMA binding for GPU X` — заданный узел не пересекается с affinity процесса. Типичная причина в arriero: менеджерский cgroup-`bind` на другой узел. Сделать это фатальным: `SGLANG_CRASH_ON_NUMA_BIND_FAILURE=1`.
- `numactl rejected hard memory binding (…); falling back to soft preferred policy (…)` — привязка сохранилась, но память теперь только «предпочтительная»; обычно виноват cpuset или seccomp-профиль контейнера.
- `numactl could not apply NUMA binding for node N (e.g. set_mempolicy/sched_setaffinity blocked by seccomp, or cpuset rejects the policy) …; skipping NUMA binding for GPU X` — не прошла даже CPU-привязка; процесс стартует непривязанным.
- `User lacks permission to set NUMA affinity …` / `pynvml not installed, …` — автоопределение отключилось; при необходимости задайте список явно.
- Перекос размещения памяти при работе: смотрите `numastat -p <pid>` для процессов `sglang::scheduler*`. В arriero тот же класс проблем ловится сигналом `numaPlacement` в health-summary инстанса (`docs/NUMA_PINNING.md`).
- Что смотреть в логе: `numa_node=` в дампе `server_args=`; предупреждения выше; при `--use-ray` — `[TP<n>] Bound to NUMA node <node> for GPU <id>`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --numa-node 0 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --base-gpu-id 2 --numa-node 0 0 1 1
```

## Источники

- `sglang/python/sglang/srt/utils/numa_utils.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/ray/scheduler_actor.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- arriero: `docs/NUMA_PINNING.md`, `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
