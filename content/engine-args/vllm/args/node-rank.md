---
schema: 1
engine: vllm
primaryName: "--node-rank"
title: "--node-rank"
summary: Нулевой индекс текущей машины в многоузловом mp-запуске. Определяет диапазон глобальных рангов узла, роль лидера DP-группы и (в режиме внешнего DP-балансировщика) выводимый `data_parallel_rank`.
group: ParallelConfig
related:
  - --nnodes
  - --master-addr
  - --master-port
  - --headless
  - --data-parallel-external-lb
  - --data-parallel-size
  - --data-parallel-size-local
  - --tensor-parallel-size
  - --pipeline-parallel-size
---

# --node-rank

## Кратко

`--node-rank R` (алиас `-r`) — единственное, чем команды на разных машинах многоузлового запуска отличаются друг от друга (кроме `--headless`). Значение обязано лежать в `[0, nnodes)`.

Из него выводится многое: диапазон глобальных рангов, которые поднимает эта машина (`local_world_size × node_rank_within_dp`), роль лидера DP-группы (`node_rank_within_dp == 0`) и, при внешнем DP-балансировщике, сам `data_parallel_rank`.

Вне многоузлового запуска (`--nnodes 1`) значение остаётся нулём и ни на что не влияет.

## Оригинальная справка

```text
distributed node rank for multi-node distributed
inference when distributed_executor_backend is mp.
```

## Паспорт аргумента

- Флаги: `--node-rank`, `-r`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=0, ge=0)` — неотрицательное целое; верхняя граница `nnodes − 1` проверяется отдельно в `create_engine_config`
- Значение по умолчанию: `0`
- Эффективное значение: не переопределяется, но переопределяет соседей — при `--nnodes > 1` вместе с внешним DP-балансировщиком из него выводится `data_parallel_rank` (лог `Inferred data_parallel_rank %d from node_rank %d for external lb`), а при внутреннем — `data_parallel_size_local`. Метод `reconfigure_for_independent_dp_rank()` заменяет `node_rank` на `node_rank_within_dp`. Исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.node_rank`
- Этап применения: `create_engine_config` (валидация и вывод DP-параметров) → `MultiprocExecutor` (смещение глобальных рангов, роль лидера) → `vllm serve` (решение «поднимать HTTP-сервер или headless-executor»)

## Что меняет в движке

**Производные свойства** (`vllm/config/parallel.py`):

```
nnodes_within_dp   = 1, если nnodes == 1, иначе nnodes // (data_parallel_size // data_parallel_size_local)
node_rank_within_dp = node_rank % nnodes_within_dp
local_world_size    = world_size // nnodes_within_dp
```

`node_rank_within_dp` — это позиция машины **внутри** её DP-шарда, и именно она, а не глобальный `node_rank`, решает роли.

**Смещение рангов.** `MultiprocExecutor` считает `global_start_rank = local_world_size × node_rank_within_dp` и создаёт worker'ов с глобальными рангами `[global_start_rank, global_start_rank + local_world_size)`.

**Лидер.** Только при `node_rank_within_dp == 0` создаётся `MessageQueue` для рассылки `SchedulerOutput` и собирается список `response_mqs` (локальные очереди для своих рангов, удалённые — для чужих). Ведомые узлы подключаются к очередям лидера.

**Headless.** В `vllm/entrypoints/cli/serve.py` при `node_rank_within_dp > 0` в headless-режиме поднимается голый `MultiprocExecutor` без API-сервера, с логом `Launching vLLM (vX) headless multiproc executor, with head node address <master_addr>:<master_port> for torch.distributed process group.`

**Вывод DP-параметров** (`create_engine_config`, только при `nnodes > 1`):

```
local_world_size            = world_size // nnodes
inferred_data_parallel_rank = (node_rank × local_world_size) // (pipeline_parallel_size × tensor_parallel_size)
```

При `data_parallel_size > 1` вместе с внешним LB это значение становится `data_parallel_rank`; при внутреннем LB и незаданном `--data-parallel-size-local` вместо этого выводится локальный размер DP.

## Значения и формат

- Целое ≥ 0. `0` — головной узел (тот, что держит API-сервер и адрес рандеву).
- Верхняя граница — `nnodes − 1`; выход за неё даёт `--node-rank must be between 0 and N-1; got --node-rank R. Set it to this node's zero-based index.`
- Алиас `-r`.
- Значение уникально для каждой машины; всё остальное в команде на узлах совпадает.
- При `--nnodes 1` любое значение, кроме 0, не имеет смысла: `nnodes_within_dp` равен 1, и `node_rank_within_dp` всегда 0.

## Когда использовать

- **Только в многоузловом mp-запуске.** Это идентификатор машины, а не настройка производительности.
- **В связке с оркестратором.** Значение обычно подставляется из индекса пода/задачи (например, `JOB_COMPLETION_INDEX` в Kubernetes или ранг задачи планировщика).
- **Не путайте с `--data-parallel-start-rank`.** Тот задаёт смещение DP-рангов при развёртывании EP через `--data-parallel-address`/`--data-parallel-rpc-port`; `--node-rank` относится к mp-схеме с `--nnodes`.
- **Не задавайте вручную вместе с `--data-parallel-rank`**: при внешнем LB `data_parallel_rank` выводится из `node_rank`, и расхождение приведёт к неверной раскладке.

## Влияние на производительность и память

- **VRAM, throughput, latency.** Прямого влияния нет: это идентификатор, а не бюджет.
- **Косвенно.** Неверный ранг ломает раскладку: два узла с одинаковым значением займут один диапазон глобальных рангов, и запуск зависнет на рандеву, не дойдя до загрузки модели.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--nnodes`: задаёт допустимый диапазон значений.
- `--master-addr`, `--master-port`: одинаковы на всех узлах и указывают на узел с `--node-rank 0`.
- `--headless`: ставится на всех узлах с ненулевым рангом внутри DP-шарда.
- `--data-parallel-external-lb` (и явный `--data-parallel-rank`): включает вывод `data_parallel_rank` из `node_rank`.
- `--data-parallel-size`, `--data-parallel-size-local`: вместе с `nnodes` определяют `nnodes_within_dp`, а значит и `node_rank_within_dp`.
- `--tensor-parallel-size`, `--pipeline-parallel-size`: входят в формулу выводимого DP-ранга.

## Типовые проблемы и диагностика

- **Симптом:** `--node-rank must be between 0 and 1; got --node-rank 2. Set it to this node's zero-based index.` **Причина:** ранг вне `[0, nnodes)`.
- **Симптом:** два узла спорят за один диапазон рангов, запуск виснет. **Причина:** одинаковый `--node-rank` на разных машинах. **Проверка:** строка `DP group leader: node_rank=%d, node_rank_within_dp=%d, ...` — она должна быть ровно одна на DP-шард.
- **Симптом:** на ведомом узле поднялся HTTP-сервер и попытался обслуживать запросы. **Причина:** забыт `--headless`. **Лечение:** добавить флаг на всех узлах с ненулевым рангом.
- **Симптом:** `Inferred data_parallel_rank 3 from node_rank 3 for external lb`, а вы ожидали другой ранг. **Причина:** DP-ранг выводится из `node_rank` и раскладки, а не задаётся отдельно. **Лечение:** пересчитать раскладку либо отказаться от внешнего LB.
- **Подтверждение принятого значения:** на ведомом узле строка `Launching vLLM (v...) headless multiproc executor, with head node address <addr>:<port> ...`; на головном — `DP group leader: node_rank=0, ...`.

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
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/docs/serving/parallelism_scaling.md`
