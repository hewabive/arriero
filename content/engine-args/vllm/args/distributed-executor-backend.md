---
schema: 1
engine: vllm
primaryName: "--distributed-executor-backend"
title: "--distributed-executor-backend"
summary: Чем запускаются worker-процессы внутри одного DP-ранга: `mp` (дочерние процессы), `uni` (единственный worker в самом процессе движка), `ray` или `external_launcher`. На одном хосте выбор делается автоматически по `pp × tp × pcp`, и трогать флаг стоит только осознанно.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --prefill-context-parallel-size
  - --data-parallel-size
  - --data-parallel-backend
  - --nnodes
  - --node-rank
  - --master-addr
  - --master-port
  - --device-ids
  - --disable-custom-all-reduce
  - --distributed-timeout-seconds
  - --async-scheduling
  - --worker-cls
  - --worker-extension-cls
  - --ray-workers-use-nsight
  - --numa-bind
---

# --distributed-executor-backend

## Кратко

Флаг определяет **исполнителя** — как поднимаются `world_size = pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size` worker-процессов одного DP-ранга. Это не про то, как ранги общаются между собой (за это отвечает `--data-parallel-backend`), и не про то, как считается модель.

На типовом одиночном хосте значение выводится само: `world_size == 1` даёт `uni`, `world_size > 1` — `mp`. Явно задавать его нужно в трёх случаях: Ray-кластер, `torchrun`-совместимый запуск (`external_launcher`) и попытка обойти автовыбор, который на этой машине даёт не то.

## Оригинальная справка

```text
Backend to use for distributed model workers, either "ray" or "mp"
(multiprocessing). If the product of pipeline_parallel_size and tensor_parallel_size
is less than or equal to the number of GPUs available, "mp" will be used to
keep processing on a single host. Otherwise, an error will be raised. To use "mp"
you must also set nnodes, and to use "ray" you must manually set
distributed_executor_backend to "ray".

Note:
    [TPU](https://docs.vllm.ai/projects/tpu/en/latest/) platform only supports Ray
    for distributed inference.
```

## Паспорт аргумента

- Флаги: `--distributed-executor-backend`
- Группа argparse: `ParallelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `ray`, `mp`, `uni`, `external_launcher`; поскольку тип поля допускает `None`, `--help` показывает еще и вариант `None` (= «решай сам»). Поле объявлено как `str | DistributedExecutorBackend | type[Executor] | None`, но подставить собственный класс `Executor` или его import-path можно только из Python-API — на CLI список `choices` этого не пропустит
- Значение по умолчанию: `null` (не задано)
- Эффективное значение: **всегда** доопределяется в `ParallelConfig.__post_init__` (см. ниже). На CPU-платформе `uni` дополнительно принудительно заменяется на `mp`, когда включено V1-мультипроцессирование
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.distributed_executor_backend`
- Этап применения: сборка `VllmConfig` → `Executor.get_class(vllm_config)` → запуск worker'ов → инициализация torch process group

## Что меняет в движке

**Автовыбор** (`ParallelConfig.__post_init__`, ветка «значение не задано»):

- `world_size_across_dp == 1` ⇒ `uni`;
- TPU с `VLLM_XLA_USE_SPMD` ⇒ `uni`;
- CUDA и `--nnodes > 1` ⇒ `mp`;
- CUDA и `device_count() < world_size` ⇒ **ошибка** `World size (N) is larger than the number of available GPUs (M) in this node.` с подсказкой про `ray` или `--nnodes`;
- `--data-parallel-backend ray` ⇒ `ray` (лог `Using ray distributed inference because data_parallel_backend is ray`);
- Ray доступен и есть placement group ⇒ `ray`;
- иначе ⇒ `mp` (`Defaulting to use mp for distributed inference`, уровень debug).

**Что стоит за каждым значением** (`Executor.get_class`):

- `mp` → `MultiprocExecutor`: `world_size` дочерних процессов, общение через shared memory и ZMQ. Способ порождения задается переменной окружения `VLLM_WORKER_MULTIPROC_METHOD` (`fork` по умолчанию, `spawn` требуется для NUMA-биндинга).
- `uni` → `UniProcExecutor`: worker живет прямо в процессе движка, отдельных процессов нет. Дешевле по RAM и по времени старта, но корректен только при `world_size == 1`.
- `ray` → `RayDistributedExecutor` (или `RayExecutorV2` при `VLLM_USE_RAY_V2_EXECUTOR_BACKEND`): worker'ы становятся акторами Ray. Требует установленного Ray — иначе `ray_utils.assert_ray_available()` падает на старте.
- `external_launcher` → `ExecutorWithExternalLauncher`: процессы поднимает внешний лаунчер (`torchrun`), ранг берется из `RANK`. Побочные эффекты видны сразу: `world_size *= data_parallel_size`, `data_parallel_rank` вычисляется из `RANK`, а `VLLM_ENABLE_V1_MULTIPROCESSING` принудительно ставится в `0` (`Disabling V1 multiprocessing for external launcher.`).

**Скрытое следствие для async scheduling.** `Executor.supports_async_scheduling()` истинно у `mp`, `uni` и `external_launcher` и ложно у Ray-исполнителей. Поэтому выбор `ray` без явного `--async-scheduling` тихо отключает асинхронное планирование (`Async scheduling will be disabled because it is not supported with the ray distributed executor backend.`), а с явным `--async-scheduling` — падает.

**Ограничение по узлам.** `--nnodes > 1` допустим только с `mp`, `uni` или `external_launcher`: `nnodes > 1 can only be set when distributed executor backend is mp, uni or external_launcher.`

## Значения и формат

- Строка из списка выше; `None` означает автовыбор.
- `mp` и `uni` отличаются не «мощностью», а числом процессов. При `-tp 1` разницы в вычислениях нет, но `uni` экономит один процесс и обмен через shm.
- `uni` при `world_size > 1` не имеет смысла: создается ровно один worker, а `init_distributed_environment` ждет `world_size` участников. Внешне это выглядит как зависший старт, который заканчивается таймаутом process group (его длину задает `--distributed-timeout-seconds`).
- `external_launcher` предполагает, что процессы уже запущены снаружи, и внутри одного процесса V1-мультипроцессирование отключается.

## Когда использовать

- **Один хост, `-tp 1`** — не задавать: автовыбор даст `uni`, это и есть оптимум.
- **Один хост, `-tp N`, N карт на месте** — не задавать: автовыбор даст `mp`. Явное `--distributed-executor-backend mp` имеет смысл разве что как защита от того, что в окружении окажется инициализированный Ray с placement group и автовыбор уедет в `ray`.
- **Несколько инстансов vLLM на одной машине** — оставлять `mp`/`uni`. Исполнители разных инстансов друг о друге не знают: каждый инстанс — самостоятельное дерево процессов со своими shm-сегментами. Разводить их по картам надо `--device-ids` или `CUDA_VISIBLE_DEVICES`, а не выбором исполнителя. В arriero каждый такой инстанс — отдельная запись с собственным memory-draw (`docs/RESOURCE_MANAGEMENT.md`).
- **`ray`** — когда кластер Ray уже есть и им же управляется размещение. Помните про потерю async scheduling и про то, что `--device-ids` в этом режиме игнорируется.
- **`external_launcher`** — для `torchrun`-совместимых сценариев, SPMD и офлайн-задач; для `vllm serve` под супервизором arriero это не рабочая раскладка.

## Влияние на производительность и память

- **RAM хоста и время старта.** `mp` добавляет `world_size` процессов Python со своими копиями рантайма; `uni` не добавляет ни одного. На `-tp 1` переход `mp` → `uni` заметно сокращает время старта и потребление RAM.
- **VRAM.** Исполнитель сам по себе VRAM не занимает; занимают worker'ы, а их число задает `world_size`.
- **Throughput.** Прямого влияния нет, но при `ray` пропадает async scheduling, что на конкурентной нагрузке отражается на latency.
- **NUMA.** `--numa-bind` для worker-подпроцессов требует `VLLM_WORKER_MULTIPROC_METHOD=spawn`; при `fork` вылезет предупреждение `Set VLLM_WORKER_MULTIPROC_METHOD=spawn to enable NUMA binding.`

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--prefill-context-parallel-size`: их произведение — `world_size`, из которого и берется автовыбор. `mp` требует, чтобы `world_size` помещался в число видимых карт узла.
- `--nnodes`, `--node-rank`, `--master-addr`, `--master-port`: многоузловой `mp`; `ray` с `--nnodes > 1` запрещен.
- `--data-parallel-backend ray`: подталкивает исполнителя к `ray`.
- `--data-parallel-size`: не входит в `world_size`, кроме `external_launcher`, где входит.
- `--device-ids`: не работает с Ray-исполнителем (предупреждение `--device-ids has no effect when using the Ray executor.`).
- `--async-scheduling`: несовместим с `ray`.
- `--ray-workers-use-nsight`: требует Ray (`Unable to use nsight profiling unless workers run with Ray.`).
- `--worker-cls`, `--worker-extension-cls`: класс worker'а, который исполнитель инстанцирует.
- `--distributed-timeout-seconds`: длина таймаута рандеву, по которому падает неверная конфигурация исполнителя.
- `--disable-custom-all-reduce`: имеет значение только когда исполнитель поднял больше одного worker'а в TP-группе.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: World size (4) is larger than the number of available GPUs (2) in this node. If this is intentional and you are using: - ray, set '--distributed-executor-backend ray'. - multiprocessing, set '--nnodes' appropriately.` **Причина:** `pp × tp × pcp` больше числа видимых карт. **Лечение:** уменьшить TP/PP, открыть карты через `--device-ids`/`CUDA_VISIBLE_DEVICES`, либо перейти на многоузловой режим.
- **Симптом:** `ValueError: nnodes > 1 can only be set when distributed executor backend is mp, uni or external_launcher.` **Лечение:** `mp` для многоузлового запуска.
- **Симптом:** `Unrecognized distributed executor backend ... Supported values are 'ray', 'mp' 'uni', 'external_launcher', custom Executor subclass or its import path.` **Причина:** значение не строка и не подкласс `Executor` (актуально для Python-API). **Лечение:** взять значение из списка.
- **Симптом:** предупреждение `Async scheduling will be disabled because it is not supported with the ray distributed executor backend.` **Причина:** выбран Ray. **Лечение:** `mp`, если async scheduling нужен.
- **Симптом:** старт «висит» и через несколько минут падает по таймауту инициализации process group. **Причина:** `uni` при `-tp > 1` либо часть worker'ов не поднялась. **Лечение:** убрать явное `uni`; для диагностики повысить `--distributed-timeout-seconds`, чтобы получить внятный стек вместо преждевременного обрыва.
- **Симптом:** на CPU-платформе выбранный `uni` в конфиге превратился в `mp`. **Причина:** OMP-окружение корректно настраивается только MP-исполнителем. **Действие:** это ожидаемо.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `distributed_executor_backend=...`; для `external_launcher` в логе `Using external launcher for distributed inference.`, для Ray-DP — `Using ray distributed inference because data_parallel_backend is ray`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --tensor-parallel-size 2 --distributed-executor-backend mp --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --tensor-parallel-size 1 --distributed-executor-backend uni --device-ids "1"
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/executor/abstract.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/v1/executor/uniproc_executor.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/platforms/cpu.py`
- `vllm/vllm/envs.py`
- `vllm/docs/serving/parallelism_scaling.md`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
