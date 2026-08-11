---
schema: 1
engine: vllm
primaryName: "--data-parallel-size-local"
title: "--data-parallel-size-local"
summary: Сколько из общих `--data-parallel-size` рангов запускается на этом узле. Задается на каждом узле многоузлового DP-развертывания; значение `0` означает «здесь только API-сервер, движков нет».
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-start-rank
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --data-parallel-hybrid-lb
  - --data-parallel-external-lb
  - --data-parallel-multi-port-external-lb
  - --data-parallel-backend
  - --headless
  - --api-server-count
  - --nnodes
---

# --data-parallel-size-local

## Кратко

`--data-parallel-size-local` разрезает глобальное `--data-parallel-size` по узлам: он говорит одному конкретному запуску `vllm serve`, сколько engine-процессов поднять локально. Сумма по всем узлам должна давать ровно `--data-parallel-size`, иначе голова развертывания будет вечно ждать недостающие ранги.

На одноузловом развертывании флаг не нужен: при `mp`-бэкенде значение по умолчанию равно `--data-parallel-size`.

## Оригинальная справка

```text
Number of data parallel replicas to run on this node.
```

## Паспорт аргумента

- Флаги: `--data-parallel-size-local`, `-dpl`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: не ограничены списком; в `ParallelConfig` поле валидируется как `ge=0`, а `create_engine_config` дополнительно требует `≤ --data-parallel-size`
- Значение по умолчанию: в объявлении отсутствует — argparse подставляет `None` («решит движок»)
- Эффективное значение: доопределяется в `create_engine_config`. При external LB принудительно `1`; при `--nnodes > 1` и internal LB выводится как `max(local_world_size // (pp × tp), 1)`; иначе — весь `--data-parallel-size`, кроме `--data-parallel-backend ray` с `VLLM_RAY_DP_PACK_STRATEGY=span`, где берется `1`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: разбор CLI → `create_engine_config` → запуск локальных engine-процессов и рукопожатие

## Что меняет в движке

Значение попадает в `ParallelConfig.data_parallel_size_local` и определяет:

1. **Сколько локальных engine-процессов создаст `CoreEngineProcManager`** — ровно `data_parallel_size_local`, с индексами от `data_parallel_rank` до `data_parallel_rank + local − 1`.
2. **Каким будет транспорт рукопожатия.** `handshake_local_only = (local_engine_count == dp_size)`: если все ранги локальные, используется IPC-сокет и `--data-parallel-rpc-port` игнорируется; иначе поднимается `tcp://<data-parallel-address>:<rpc-port>`.
3. **Сколько удаленных рангов будет ждать голова.** `remote_count = dp_size − data_parallel_size_local`, и цикл ожидания не имеет таймаута.
4. **Дефолт `--api-server-count` в hybrid-режиме** — он равен `data_parallel_size_local`.

Отдельный смысл имеет `0`: в `ParallelConfig.__post_init__` условие `data_parallel_size > 1 or data_parallel_size_local == 0` означает «параллелизм задан аргументами движка», то есть `0` — сентинел, позволяющий поднять узел **только с API-сервером**, без единого локального движка. В `--headless` такое значение запрещено: `data_parallel_size_local must be > 0 in headless mode`.

## Значения и формат

- Целое от `0` до `--data-parallel-size`.
- `0` — «на этом узле только фронтенд»; все ранги живут на других узлах и обязаны быть запущены с `--headless`.
- `1` — единственно допустимое значение в external-LB режиме (`--data-parallel-rank` / `--data-parallel-external-lb`); больше — ошибка. Оно же переключает hybrid-режим в external с предупреждением.
- Пропуск флага на одноузловом `mp`-развертывании эквивалентен `--data-parallel-size-local <dp>`.
- Для `--data-parallel-backend ray` со стратегией размещения `span` (`VLLM_RAY_DP_PACK_STRATEGY=span`, переменная окружения, не CLI) значение игнорируется и вычисляется автоматически.

## Когда использовать

- На каждом узле многоузлового DP-развертывания с `mp`-бэкендом: без него узел попытается поднять все `--data-parallel-size` рангов.
- `--data-parallel-size-local 0` — когда API-сервер вынесен на отдельную машину (например, во фронтовый под), а все GPU-ранги на другой.
- В hybrid-режиме — обязательно вместе с `--data-parallel-start-rank`: без `--data-parallel-size-local` включение `--data-parallel-hybrid-lb` падает с явной ошибкой.
- Не задавайте на одном узле: значение по умолчанию уже правильное, а ошибочно маленькое число тихо превратит часть рангов в «удаленные» и подвесит старт.

## Влияние на производительность и память

Прямого влияния на VRAM и скорость нет — флаг только распределяет уже заданное `--data-parallel-size` по машинам. Косвенно он определяет, сколько реплик модели будет загружено в память **этого** узла: локальное потребление = `data_parallel_size_local × (веса + KV-cache + активации одного ранга)`.

## Взаимодействие с другими аргументами

- `--data-parallel-size`: жесткая граница сверху; `data_parallel_size_local (X) must be <= data_parallel_size (Y)`.
- `--data-parallel-start-rank`: пара «сколько рангов» + «с какого начинаются» полностью описывает долю узла.
- `--data-parallel-external-lb` / `--data-parallel-rank`: требуют `1` (или пропуска флага).
- `--data-parallel-hybrid-lb`: требует явного значения; при `1` автоматически откатывается в external LB.
- `--data-parallel-multi-port-external-lb`: требует `≥ 2` и делимости `--data-parallel-size` на это значение.
- `--headless`: требует `> 0`.
- `--data-parallel-rpc-port`, `--data-parallel-address`: становятся значимыми ровно тогда, когда `data_parallel_size_local < data_parallel_size`.
- `--api-server-count`: в hybrid-режиме по умолчанию берется отсюда.

## Типовые проблемы и диагностика

- **Симптом:** старт зависает на `Waiting for %d local, %d remote core engine proc(s) to connect.` **Причина:** сумма `--data-parallel-size-local` по узлам меньше `--data-parallel-size`. **Лечение:** досчитать ранги; таймаута нет, процесс будет ждать бесконечно.
- **Симптом:** `ValueError: data_parallel_size_local (6) must be <= data_parallel_size (4)`. **Причина:** локальных рангов больше глобальных. **Лечение:** уменьшить локальное значение или поднять `--data-parallel-size`.
- **Симптом:** `Invalid data-parallel launch options: an external data-parallel rank requires --data-parallel-size-local 1; got 2. Set it to 1 or omit it.` **Причина:** external LB с локальным размером больше единицы. **Лечение:** убрать флаг либо перейти на hybrid/multi-port.
- **Симптом:** предупреждение `data_parallel_hybrid_lb is not eligible when data_parallel_size_local = 1, autoswitch to data_parallel_external_lb.` **Причина:** hybrid с одним локальным рангом вырождается в external. **Действие:** штатный откат, но `--api-server-count` при этом станет 1.
- **Симптом:** `ValueError: data_parallel_size_local must be > 0 in headless mode`. **Причина:** `--headless` без локальных движков. **Лечение:** `0` допустим только на узле **с** API-сервером.
- **Подтверждение принятого значения:** на headless-узле в логе `Launching %d data parallel engine(s) in headless mode, with head node address %s.` — первое число и есть локальный размер.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/DeepSeek-V2-Lite --headless --data-parallel-size 4 --data-parallel-size-local 4 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
