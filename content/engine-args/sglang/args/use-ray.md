---
schema: 1
engine: sglang
primaryName: "--use-ray"
title: "--use-ray"
summary: Запускает scheduler'ы как Ray-акторы в placement group вместо обычных подпроцессов. Нужен только там, где кластером уже управляет Ray; в остальных случаях добавляет зависимость и слой отказов.
group: device
related:
  - --tp-size
  - --pp-size
  - --dp-size
  - --nnodes
  - --node-rank
  - --dist-init-addr
  - --nccl-port
  - --base-gpu-id
  - --numa-node
  - --grpc-port
  - --elastic-ep-backend
---

# --use-ray

## Кратко

`--use-ray` меняет способ порождения scheduler-процессов: вместо `multiprocessing.Process` создаются Ray-акторы `SchedulerActor`, размещенные по бандлам placement group. Карты акторам выдает Ray (`ray.get_runtime_context().get_accelerator_ids()`), а не формула `--base-gpu-id` / `--gpu-id-step`. Флаг осмысленен только внутри существующего Ray-кластера; вне его он приносит внешнюю зависимость (`pip install 'sglang[ray]'`) и запреты на несколько других возможностей.

## Оригинальная справка

```text
Use Ray actors for scheduler process management.
```

## Паспорт аргумента

- Флаги: `--use-ray`
- Группа: `device`
- Тип значения: bool (`store_true`)
- Допустимые значения: флаг без значения; парного отключающего флага нет
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным
- Где объявлен: `ServerArgs.use_ray`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: выбор точки входа в `run_server` (`sglang/python/sglang/launch_server.py`) → `RayEngine._launch_scheduler_processes` вместо `Engine._launch_scheduler_processes`

## Что меняет в движке

### Точка входа

`run_server` выбирает ветку до всякой инициализации:

```python
elif server_args.use_ray:
    try:
        from sglang.srt.ray.http_server import launch_server
    except ImportError:
        raise ImportError("Ray is required for --use-ray mode. Install it with: pip install 'sglang[ray]'")
```

То есть отсутствие Ray в окружении — отказ на старте с внятным сообщением, а не деградация.

### Размещение и карты

`RayEngine._launch_scheduler_processes` (`sglang/python/sglang/srt/ray/engine.py`) берет текущую placement group либо создает свою: `nnodes` бандлов по `{"CPU": 1, "GPU": gpus_per_node}`, стратегия `STRICT_PACK` на одном узле и `SPREAD` на нескольких (в лог идет `No placement group detected. Auto-creating one with … bundle(s), … GPU(s)/bundle`). Каждый актор объявляется как `num_cpus=0, num_gpus=1` и получает имя вида `sglang_scheduler_node<ip>_dp<n>_pp<n>_tp<n>_pg<hex>_bundle<n>`.

Внутри актора (`sglang/python/sglang/srt/ray/scheduler_actor.py`) карта берется у Ray:

```python
assigned_gpus = ray.get_runtime_context().get_accelerator_ids().get("GPU", [])
actual_gpu_id = int(assigned_gpus[0]) if assigned_gpus else gpu_id
```

Строка лога — `[TP<n>] Ray assigned GPU: <id>` либо `[TP<n>] Using passed gpu_id: <id>`. Вычисленный из `--base-gpu-id`/`--gpu-id-step` индекс остается только запасным вариантом.

### Рандеву и NCCL

Адрес рандеву собирается как `<ip узла ранга 0>:<port_args.nccl_port>`; при `--dp-size 1` он печатается строкой `dist_init_addr: …`. То есть `--nccl-port` и `--dist-init-addr` в Ray-режиме продолжают действовать, но адрес хоста выводится из размещения акторов.

### NUMA

Обертка `numactl` (обычный путь `SGLANG_NUMA_BIND_V2`) в акторе неприменима — процесс запускаем не мы. Поэтому `SchedulerActor` всегда делает привязку изнутри: `numa_bind_to_node(get_numa_node_if_available(server_args, actual_gpu_id))` со строкой `[TP<n>] Bound to NUMA node <node> for GPU <id>`. Политика памяти получается мягкой (`numa_set_preferred`), а не жесткой.

### Завершение

`RayEngine.shutdown` сначала делает `ray.kill` каждому актору, затем обычную остановку локальных процессов. Неудача убийства пишется как `Failed to kill Ray scheduler actor: …`.

## Значения и формат

- Булев флаг без значения.
- «Выключено» = не указывать.
- Требует установленного экстра-набора `sglang[ray]`; иначе `ImportError` на старте.
- Флаг не настраивает сам Ray: адрес кластера, ресурсы и placement group задаются средствами Ray и переменными `RAY_*`. Из движка на размещение влияет только `SGLANG_RAY_BUNDLE_INDICES` (для внешней placement group).

## Когда использовать

- Инференс встроен в Ray-приложение (Ray Serve, общий пул ресурсов), и планировать GPU должен один шедулер — Ray, а не два конкурирующих.
- Многоузловой запуск, где размещение по узлам уже описано placement group; тогда `SPREAD`-бандлы заменяют ручную раскладку `--nnodes`/`--node-rank`.
- Не включать на одиночном хосте «для управляемости»: обычный путь `multiprocessing` проще, не требует установленного Ray и не запрещает нативный gRPC.
- Не включать, если планируется elastic-EP scale-up: он явно несовместим (см. ниже).
- **В arriero:** менеджер сам является супервизором процессов (`apps/api/src/process/supervisor.ts`): он запускает `<env>/bin/python -m sglang.launch_server` напрямую, следит за pid и переусыновляет процесс после своего перезапуска. Ray-акторы живут вне этого дерева, поэтому надзор менеджера на них не распространяется — комбинация возможна технически, но лишает управление менеджера смысла.

## Влияние на производительность и память

- На арифметику модели не влияет: считает тот же scheduler и тот же model runner.
- Время старта растет: создание placement group и ожидание `pg.ready()`, инициализация акторов.
- RAM хоста: добавляются процессы самого Ray (raylet, GCS при локальном кластере).
- VRAM: не меняется, но карта выдается Ray, поэтому фактическое распределение может отличаться от расчета `--base-gpu-id`.
- Latency под нагрузкой: без изменений — Ray участвует только в запуске и завершении, а не в тракте запроса.

## Взаимодействие с другими аргументами

- `--grpc-port`: несовместим. `ValueError: --grpc-port is not supported with --use-ray: the Ray serve launch path does not start the native gRPC server.`
- `--elastic-ep-backend` + `--max-ep-size` (runtime scale-up): несовместим — `assert not self.use_ray, "Elastic EP runtime scale-up does not support --use-ray."`
- `--base-gpu-id` / `--gpu-id-step`: в Ray-режиме их результат используется только если Ray не выдал устройство.
- `--numa-node`: применяется, но только по in-process-пути (см. выше).
- `--nccl-port` / `--dist-init-addr`: продолжают задавать точку рандеву; хост берется из размещения ранга 0.
- `--nnodes` / `--pp-size` / `--tp-size` / `--dp-size`: определяют размер world и число бандлов автосозданной placement group.

## Типовые проблемы и диагностика

- `ImportError: Ray is required for --use-ray mode. Install it with: pip install 'sglang[ray]'` — экстра-набор не установлен.
- `RuntimeError: Engine node <ip> not found in any placement group bundle […]. Rank-0 scheduler must be co-located with the Engine.` — процесс с движком запущен не на том узле, где есть бандл; нужно шедулить сам движок в ту же placement group.
- `Custom placement group validation failed: …` — переданная извне placement group не покрывает world size.
- Актор занял не ту карту — смотрите `[TP<n>] Ray assigned GPU: <id>`: приоритет у Ray, а не у `--base-gpu-id`.
- Что смотреть в логе: `No placement group detected. Auto-creating one with …`, `Ray cluster (auto PG): … nodes, … GPUs/node, world_size=…`, `dist_init_addr: …`, `use_ray=` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --use-ray --tensor-parallel-size 2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --use-ray --tensor-parallel-size 4 --nnodes 2 --node-rank 0 --dist-init-addr 192.168.0.2:25000
```

## Источники

- `sglang/python/sglang/launch_server.py`
- `sglang/python/sglang/srt/ray/engine.py`
- `sglang/python/sglang/srt/ray/scheduler_actor.py`
- `sglang/python/sglang/srt/ray/data_parallel_controller.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/numa_utils.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
