---
schema: 1
engine: vllm
primaryName: "--data-parallel-rank"
title: "--data-parallel-rank"
summary: Номер DP-ранга, который обслуживает именно этот запуск `vllm serve`. Само наличие флага включает режим внешней балансировки, поэтому его задают по одному разу на каждый процесс-реплику и только для MoE-моделей.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-external-lb
  - --data-parallel-hybrid-lb
  - --data-parallel-multi-port-external-lb
  - --data-parallel-start-rank
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --api-server-count
  - --enable-fault-tolerance
  - --node-rank
  - --nnodes
---

# --data-parallel-rank

## Кратко

`--data-parallel-rank K` объявляет: «этот процесс — реплика номер `K` из `--data-parallel-size`». Флаг не просто нумерует — он **неявно включает external LB**: `data_parallel_external_lb = self.data_parallel_external_lb or self.data_parallel_rank is not None`. Поэтому одного `--data-parallel-rank` достаточно, чтобы получить раскладку «один процесс — один ранг — свой HTTP-порт», где балансировкой занимается что-то снаружи vLLM.

Общая картина DP-топологии — в `--data-parallel-size`; здесь только про роль ранга.

## Оригинальная справка

```text
Data parallel rank of this instance. When set, enables external load balancer mode for MoE data-parallel deployments. Unsupported for non-MoE models; launch independent vLLM instances instead.
```

## Паспорт аргумента

- Флаги: `--data-parallel-rank`, `-dpn`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: не ограничены списком; `ParallelConfig.__post_init__` требует `0 ≤ rank < data_parallel_size`
- Значение по умолчанию: в объявлении отсутствует — argparse подставляет `None` («ранг не задан, external LB не включен»)
- Эффективное значение: при `--nnodes > 1` **вместе с явным** `--data-parallel-external-lb` значение перезаписывается выведенным из `--node-rank` (`Inferred data_parallel_rank %d from node_rank %d for external lb`). В `create_engine_config` в `ParallelConfig` уходит `data_parallel_rank or 0`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: разбор CLI → выбор режима LB в `vllm/entrypoints/cli/serve.py` → `create_engine_config` → индексация engine-процесса и рукопожатие

## Что меняет в движке

- **Режим балансировки.** Наличие ранга переводит запуск в external LB: `--data-parallel-size-local` фиксируется в 1, `data_parallel_hybrid_lb` сбрасывается в `False`, `--api-server-count` по умолчанию становится 1.
- **Индекс engine-процесса.** `CoreEngineProcManager` запускается со `start_index = data_parallel_rank`, и рукопожатие с рангом 0 идет по этому индексу. Ранг 0 в external LB держит DP-координатор и ждет `HELLO` от всех `dp_size` движков; ранги `> 0` рукопожимаются со своим локальным движком и с фронтендом ранга 0.
- **Ключ KV-transfer.** При заданном `kv_transfer_config` к `engine_id` дописывается `_dp<rank>`, чтобы идентификаторы реплик не совпадали.
- **Проверка согласованности.** `data_parallel_rank` входит в `ignored_factors` `ParallelConfig.compute_hash()` — то есть он **обязан** различаться между процессами и не ломает проверку идентичности конфигураций.

## Значения и формат

- Целое из `[0, --data-parallel-size)`. Каждое значение диапазона должно быть занято ровно одним процессом.
- Ранги, живущие на одной машине, обязаны различаться `--port` (`--data-parallel-rpc-port` при этом остается общим и берется по умолчанию).
- Ранг `0` особенный: на нем поднимается DP-координатор, поэтому его надо стартовать так, чтобы остальные могли достучаться до `--data-parallel-address`.
- `None` (флаг не задан) означает «external LB не запрашивается»; ранг тогда либо 0, либо выводится из `--data-parallel-start-rank`/`--node-rank`.

## Когда использовать

- Когда балансировщик уже есть (ingress, роутер, прокси arriero) и нужен один HTTP-эндпоинт на реплику с независимой телеметрией.
- В Kubernetes-раскладке «один под — один ранг» для wide-EP MoE.
- Не используйте на плотной модели: `--data-parallel-size > 1` + external LB даст `Non-MoE models do not support external data parallel mode.` Для плотной модели нужны просто независимые инстансы без `--data-parallel-*`.
- Не задавайте вместе с `--data-parallel-multi-port-external-lb`: супервизор сам раздает ранги дочерним процессам и отвергает явный флаг.

## Влияние на производительность и память

Сам номер ранга ничего не стоит. Практическое следствие режима, который он включает: на каждом процессе поднимается собственный API-сервер (`--api-server-count 1`), поэтому фронтенд перестает быть общим узким местом, но и внутренняя балансировка по очередям движков (running/waiting) больше не работает — качество распределения полностью на внешнем LB.

## Взаимодействие с другими аргументами

- `--data-parallel-external-lb`: тот же режим, включаемый явно; комбинация с `--data-parallel-hybrid-lb` запрещена.
- `--data-parallel-size-local`: допустимо только `1` или пропуск.
- `--data-parallel-start-rank`: альтернативный (hybrid) способ разметки; одновременно с `--data-parallel-rank` даст `Cannot use more than one data parallel load balancing mode.`
- `--data-parallel-address` / `--data-parallel-rpc-port`: адрес и порт ранга 0, обязательны, когда ранги на разных машинах.
- `--nnodes` + `--node-rank`: при явном `--data-parallel-external-lb` ранг выводится из них и перекрывает переданное значение.
- `--enable-fault-tolerance`: работает только в external LB, то есть требует этот флаг или `--data-parallel-external-lb`.
- `--port`: у co-located рангов обязан быть разным.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: data_parallel_rank (4) must be in the range [0, 4)`. **Причина:** ранг вне диапазона. **Лечение:** нумерация с нуля.
- **Симптом:** `Non-MoE models do not support external data parallel mode. For external load balancing, launch independent vLLM instances without --data-parallel-* arguments.` **Причина:** плотная модель. **Лечение:** отдельные инстансы без DP-флагов.
- **Симптом:** `Invalid data-parallel launch options: an external data-parallel rank requires --data-parallel-size-local 1; got 2.` **Лечение:** убрать `--data-parallel-size-local`.
- **Симптом:** старт ранга `> 0` висит в ожидании. **Причина:** ранг 0 еще не поднялся либо `--data-parallel-address`/`--data-parallel-rpc-port` не совпадают. **Лечение:** поднимать ранг 0 первым, сверить адрес и порт.
- **Симптом:** `Message from engine with unexpected data parallel rank: N`. **Причина:** два процесса взяли один ранг либо ранг не входит в ожидаемый набор. **Лечение:** проверить уникальность значений по всем запускам.
- **Симптом:** `Error: --data-parallel-multi-port-external-lb manages child --data-parallel-rank values internally`. **Лечение:** убрать `--data-parallel-rank`.
- **Подтверждение принятого значения:** процесс API-сервера в multi-port режиме называется `APIServer_DP<rank>`; при выводе ранга из `--node-rank` в лог уходит `Inferred data_parallel_rank %d from node_rank %d for external lb`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --data-parallel-rank 0 --port 8000
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --data-parallel-rank 1 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345 --port 8000
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
