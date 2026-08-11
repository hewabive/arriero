---
schema: 1
engine: vllm
primaryName: "--data-parallel-start-rank"
title: "--data-parallel-start-rank"
summary: Номер первого DP-ранга, который поднимает этот узел. Задается на вторичных узлах вместе с `--data-parallel-size-local`; в не-headless запуске он же включает hybrid-режим балансировки.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-hybrid-lb
  - --data-parallel-rank
  - --data-parallel-external-lb
  - --data-parallel-multi-port-external-lb
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --headless
  - --api-server-count
  - --node-rank
---

# --data-parallel-start-rank

## Кратко

`--data-parallel-start-rank S` вместе с `--data-parallel-size-local L` означает «этот узел держит ранги `S … S+L−1`». Флаг нужен только на вторичных узлах многоузлового DP-развертывания: на головном узле ранги начинаются с нуля.

Второй эффект — режимный: если запуск **не** `--headless`, ненулевой `--data-parallel-start-rank` включает hybrid LB (`Set explicitly in conjunction with --data-parallel-start-rank` в справке `--data-parallel-hybrid-lb`). Общая карта режимов — в `--data-parallel-size`.

## Оригинальная справка

```text
Starting data parallel rank for secondary nodes.
```

## Паспорт аргумента

- Флаги: `--data-parallel-start-rank`, `-dpr`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: не ограничены списком; итоговый ранг проходит проверку `0 ≤ rank < data_parallel_size`
- Значение по умолчанию: в объявлении отсутствует — argparse подставляет `None`
- Эффективное значение: используется только в ветке `create_engine_config`, где задан `--data-parallel-size-local`; там `data_parallel_rank = data_parallel_start_rank or inferred_data_parallel_rank`. Без `--data-parallel-size-local` значение **не читается** и ранг остается нулевым
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: разбор CLI → выбор режима LB в `vllm/entrypoints/cli/serve.py` → `create_engine_config` → индексация локальных engine-процессов

## Что меняет в движке

Значение становится `ParallelConfig.data_parallel_rank` этого узла, а `CoreEngineProcManager` создает `data_parallel_size_local` процессов с индексами `start_rank … start_rank + local − 1`. Дальше:

- **headless-узел** (`--headless`): чистое смещение. Проверка `if self.data_parallel_start_rank and not headless` не срабатывает, hybrid не включается, узел остается частью internal-LB развертывания с единственным API-сервером на голове.
- **не-headless узел**: тот же код выставляет `data_parallel_hybrid_lb = True`. Узел поднимает собственный API-сервер, балансирует между своими локальными рангами, а между узлами балансирует что-то внешнее. `--api-server-count` при этом по умолчанию равен `--data-parallel-size-local`.

Обратите внимание на `or` в `data_parallel_start_rank or inferred_data_parallel_rank`: значение `0` ложно, поэтому `--data-parallel-start-rank 0` ведет себя ровно так же, как отсутствие флага (и hybrid тоже не включает).

## Значения и формат

- Целое `≥ 0`; осмысленные значения — кратные `--data-parallel-size-local`, чтобы диапазоны узлов не пересекались.
- `0` эквивалентно отсутствию флага.
- Сумма `--data-parallel-size-local` по всем узлам должна равняться `--data-parallel-size`, а диапазоны `[S, S+L)` — покрывать `[0, dp_size)` без пересечений.
- Флаг бессмысленен на одноузловом развертывании и в external-LB режиме (там ранг задается через `--data-parallel-rank`).

## Когда использовать

- На каждом вторичном узле internal-LB развертывания: `--headless --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 2`.
- Для hybrid-раскладки, когда нужен API-сервер на каждом узле и внешний LB между узлами.
- Не используйте вместе с `--data-parallel-rank`: это два разных режима, и `vllm serve` откажет.
- Не используйте вместо `--node-rank`: при `--nnodes > 1` ранг может быть выведен автоматически из `--node-rank`, и явный `--data-parallel-start-rank` тогда просто перекрывает вывод.

## Влияние на производительность и память

Само смещение ничего не стоит. Значим побочный эффект в не-headless запуске: hybrid-режим оставляет планирование локальным, снимает нагрузку с единственного фронтенда и убирает межузловой трафик балансировки, но требует внешнего балансировщика перед узлами.

## Взаимодействие с другими аргументами

- `--data-parallel-size-local`: без него значение игнорируется; вместе они задают диапазон рангов узла.
- `--data-parallel-hybrid-lb`: выводится из этого флага в не-headless запуске; задавать оба явно допустимо.
- `--headless`: подавляет вывод hybrid-режима, оставляя только смещение рангов.
- `--data-parallel-rank`, `--data-parallel-external-lb`, `--data-parallel-multi-port-external-lb`: взаимно исключены с этим флагом на уровне выбора режима.
- `--data-parallel-address`, `--data-parallel-rpc-port`: обязаны совпадать с головным узлом.
- `--api-server-count`: в hybrid-режиме по умолчанию берется из `--data-parallel-size-local`.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но все ранги узла оказались нулевыми, и голова ждет недостающие. **Причина:** не задан `--data-parallel-size-local` — ветка, читающая `--data-parallel-start-rank`, не выполняется. **Лечение:** добавить `--data-parallel-size-local`.
- **Симптом:** `Cannot use more than one data parallel load balancing mode. Choose one of: --data-parallel-multi-port-external-lb, --data-parallel-external-lb (or --data-parallel-rank), --data-parallel-hybrid-lb (or --data-parallel-start-rank).` **Причина:** смешаны режимы. **Лечение:** оставить один.
- **Симптом:** `AssertionError: data_parallel_hybrid_lb is not applicable in headless mode`. **Причина:** `--headless` вместе с явным `--data-parallel-hybrid-lb`. **Лечение:** на headless-узле оставить только `--data-parallel-start-rank`.
- **Симптом:** `Message from engine with unexpected data parallel rank: N` или бесконечное `Waiting for %d local, %d remote core engine proc(s) to connect.` **Причина:** диапазоны узлов пересеклись или не покрыли `[0, dp_size)`. **Лечение:** пересчитать смещения.
- **Подтверждение принятого значения:** при `--nnodes > 1` в лог уходит `Inferred data_parallel_rank %d from node_rank %d`; в hybrid-режиме — `Defaulting api_server_count to data_parallel_size_local (%d) for hybrid LB mode.`

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --headless --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 2 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 2 --data-parallel-hybrid-lb --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
