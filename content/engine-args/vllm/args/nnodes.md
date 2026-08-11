---
schema: 1
engine: vllm
primaryName: "--nnodes"
title: "--nnodes"
summary: Число узлов в многоузловом запуске на multiprocessing-backend'е — альтернатива Ray. Одна и та же команда запускается на каждом узле, отличаясь только `--node-rank`; ведомые узлы стартуют с `--headless`.
group: ParallelConfig
related:
  - --node-rank
  - --master-addr
  - --master-port
  - --headless
  - --distributed-executor-backend
  - --data-parallel-backend
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --data-parallel-size
---

# --nnodes

## Кратко

`--nnodes N` (алиас `-n`) говорит vLLM, что глобальный мир рангов размазан по N машинам и собирать его надо своими средствами, без Ray. Каждый узел запускает одну и ту же команду, меняя только `--node-rank`; все узлы, кроме нулевого, добавляют `--headless` (без HTTP-сервера).

Точка рандеву — `--master-addr`/`--master-port` головного узла. Локальный мир каждой машины равен `world_size / nnodes_within_dp`, и на этой машине поднимается ровно столько worker-процессов.

Наличие `--nnodes > 1` меняет и логику выбора backend'а: на CUDA движок сразу берёт `mp` и **пропускает** проверку «мир больше числа локальных карт», которая иначе остановила бы старт.

## Оригинальная справка

```text
num of nodes for multi-node distributed
inference when distributed_executor_backend is mp.
```

## Паспорт аргумента

- Флаги: `--nnodes`, `-n`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=1, ge=1)` — целое не меньше 1
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется, но участвует в производных `nnodes_within_dp = nnodes // (data_parallel_size // data_parallel_size_local)` и `local_world_size = world_size // nnodes_within_dp`, а также в выводе `data_parallel_rank`/`data_parallel_size_local` из `--node-rank` (`EngineArgs.create_engine_config`). Исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.nnodes`
- Этап применения: разбор CLI и `create_engine_config` (валидация делимости мира) → `ParallelConfig.__post_init__` (выбор backend'а) → `MultiprocExecutor` (сколько worker'ов поднять локально) → инициализация process group по `--master-addr`

## Что меняет в движке

**Валидация в `create_engine_config`** (только при `nnodes > 1`):

- `--data-parallel-backend` обязан быть `mp`: `--nnodes N requires --data-parallel-backend mp`;
- `world_size = data_parallel_size × pipeline_parallel_size × tensor_parallel_size` обязан делиться на `nnodes`: `--nnodes N must evenly divide the total world size (W). Adjust --nnodes, --data-parallel-size, --pipeline-parallel-size, or --tensor-parallel-size.`;
- `--node-rank` обязан лежать в `[0, nnodes)`.

Оттуда же выводится `data_parallel_rank` для внешнего DP-балансировщика и, при внутреннем, `data_parallel_size_local`.

**Валидация в `ParallelConfig.__post_init__`:** backend должен быть из `("mp", "uni", "external_launcher")`, иначе `nnodes > 1 can only be set when distributed executor backend is mp, uni or external_launcher.` Ветка выбора backend'а на CUDA при `nnodes > 1` сразу берёт `mp`, минуя проверку `device_count() < world_size` — иначе многоузловой запуск был бы невозможен по определению.

**Локальный мир.** `MultiprocExecutor._get_parallel_sizes` утверждает делимость `world_size % nnodes_within_dp == 0` и берёт `local_world_size = world_size // nnodes_within_dp`. Дальше поднимается `local_world_size` worker-подпроцессов, а глобальные ранги считаются со смещением `local_world_size × node_rank_within_dp`.

**Рандеву.** `init_distributed_environment` при `nnodes > 1` (и backend'е, отличном от `external_launcher`, без elastic EP) строит `distributed_init_method` из `master_addr`/`master_port`, а не из локального file-store.

**Роли.** Узел с `node_rank_within_dp == 0` создаёт очереди сообщений (`MessageQueue`) и является лидером своей DP-группы; остальные подключаются к нему как клиенты.

## Значения и формат

- Целое ≥ 1. `1` — обычный однохостовый запуск, все прочие многоузловые ограничения не действуют.
- `0` отвергается валидацией `ge=1`.
- Алиас `-n`.
- Значение должно быть одинаковым на всех узлах — оно определяет, сколько машин будет ждать рандеву.
- Многоузловой запуск через Ray этим флагом **не** управляется: там достаточно `--distributed-executor-backend ray` и работающего кластера.

## Когда использовать

- **Модель не помещается на один узел, а Ray в контуре не нужен.** Multiprocessing-путь не требует установки и поддержки Ray-кластера; цена — запуск команды на каждой машине вручную или средствами внешнего оркестратора.
- **Каноническая раскладка:** `--tensor-parallel-size` = число карт в узле, `--pipeline-parallel-size` = число узлов, `--nnodes` = число узлов.
- **Не используйте на одной машине.** `--nnodes 1` — и есть значение по умолчанию; выставлять его больше единицы «про запас» опасно: пропадёт проверка на нехватку локальных карт, и вместо понятной ошибки вы получите зависание на рандеву.
- **Не забудьте `--headless`** на всех узлах, кроме нулевого: иначе каждый поднимет свой HTTP-сервер.

## Влияние на производительность и память

- **VRAM.** Флаг не меняет распределение памяти: его задают TP/PP/DP. Он лишь определяет, на скольких машинах живут эти ранги.
- **Сеть.** Становится критическим ресурсом. Для TP через границу узла нужен быстрый интерконнект (InfiniBand/RoCE с GPUDirect RDMA); на обычном TCP-сокете межузловой TP теряет производительность катастрофически. Проверка — `NCCL_DEBUG=TRACE` и наличие `[send] via NET/IB/GDRDMA` вместо `[send] via NET/Socket`.
- **Время старта.** Растёт: рандеву всех рангов, отдельная загрузка весов на каждой машине (модель должна лежать по одинаковому пути на всех узлах или на общей ФС).
- **Latency.** PP через границу узла терпим (одна передача скрытых состояний на батч), TP — нет.

## Взаимодействие с другими аргументами

- `--node-rank`: индекс текущей машины, обязан быть в `[0, nnodes)`.
- `--master-addr`, `--master-port`: адрес рандеву; должны указывать на головной узел и совпадать на всех машинах.
- `--headless`: ставится на всех узлах, кроме `--node-rank 0`.
- `--distributed-executor-backend`: допустимы `mp`, `uni`, `external_launcher`; `ray` с `--nnodes > 1` запрещён.
- `--data-parallel-backend`: обязан быть `mp`.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--data-parallel-size`: их произведение обязано делиться на `nnodes`.

## Типовые проблемы и диагностика

- **Симптом:** `--nnodes 3 must evenly divide the total world size (16). Adjust --nnodes, --data-parallel-size, --pipeline-parallel-size, or --tensor-parallel-size.` **Лечение:** привести раскладку к делимости.
- **Симптом:** `nnodes > 1 can only be set when distributed executor backend is mp, uni or external_launcher.` **Причина:** задан `--distributed-executor-backend ray`. **Лечение:** либо Ray без `--nnodes`, либо `mp` с `--nnodes`.
- **Симптом:** `--nnodes 2 requires --data-parallel-backend mp; got --data-parallel-backend ray.` **Лечение:** по тексту.
- **Симптом:** `--node-rank must be between 0 and 1; got --node-rank 2.` **Причина:** рассинхрон между `--nnodes` и `--node-rank`.
- **Симптом:** узлы стартовали, но зависли до загрузки модели. **Причина:** не сходится рандеву — неверный `--master-addr`, закрытый `--master-port`, разные значения флагов на узлах. **Проверка:** строка `world_size=%d rank=%d local_rank=%d distributed_init_method=%s backend=%s` в логе каждого узла; методика — `vllm/docs/serving/distributed_troubleshooting.md`.
- **Подтверждение принятого значения:** на лидере строка `DP group leader: node_rank=%d, node_rank_within_dp=%d, master_addr=%s, mq_connect_ip=%s (local), world_size=%d, local_world_size=%d`.

## Примеры

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --nnodes 2 --node-rank 0 --master-addr 192.168.1.100
```

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --nnodes 2 --node-rank 1 --master-addr 192.168.1.100 --headless
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/docs/serving/parallelism_scaling.md`
- `vllm/docs/serving/distributed_troubleshooting.md`
