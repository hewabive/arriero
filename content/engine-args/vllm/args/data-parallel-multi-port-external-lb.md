---
schema: 1
engine: vllm
primaryName: "--data-parallel-multi-port-external-lb"
title: "--data-parallel-multi-port-external-lb"
summary: Запускает на узле супервизор, который сам поднимает по одному external-LB серверу на каждый локальный DP-ранг (порты `--port`, `--port+1`, …) и отдает агрегированный `/health` на отдельном порту.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-start-rank
  - --data-parallel-rank
  - --data-parallel-external-lb
  - --data-parallel-hybrid-lb
  - --data-parallel-supervisor-port
  - --dp-supervisor-probe-interval-s
  - --dp-supervisor-probe-timeout-s
  - --dp-supervisor-probe-failure-threshold
  - --port
  - --host
  - --api-server-count
  - --device-ids
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --node-rank
  - --grpc
  - --uds
  - --ssl-keyfile
  - --ssl-certfile
---

# --data-parallel-multi-port-external-lb

## Кратко

Это упаковка external-LB режима в один процесс запуска. Вместо того чтобы стартовать `--data-parallel-size-local` отдельных команд `vllm serve --data-parallel-rank K --port ...`, вы запускаете одну команду: супервизор сам породит дочерние серверы, раздаст им ранги, порты и карты, а внешнему балансировщику отдаст один общий `/health`, который зеленеет только когда живы все дети.

Флаг задается на узле и полностью обрабатывается на уровне CLI — в `ParallelConfig` он не попадает. Общая карта режимов — в `--data-parallel-size`.

## Оригинальная справка

```text
Run a node-local supervisor that launches one external-LB API server per local data parallel rank and exposes aggregated health on a supervisor port.
```

## Паспорт аргумента

- Флаги: `--data-parallel-multi-port-external-lb`, `-dpm`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`action='store_true'`, парного `--no-...` нет)
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; но у **дочерних** процессов он принудительно сбрасывается в `False` вместе с подменой `--data-parallel-rank`, `--data-parallel-size-local 1`, `--data-parallel-external-lb true`, `--api-server-count 1`, `--port` и `--device-ids`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: разбор CLI → `validate_parsed_serve_args` → ветка `run_dp_supervisor(args)` в `vllm/entrypoints/cli/serve.py`; в `VllmConfig` значение не передается

## Что меняет в движке

`ServeSubcommand.cmd` вместо обычного `run_server` вызывает `run_dp_supervisor(args)`. Дальше `DPSupervisor`:

1. **Порождает детей** методом `spawn`, по одному на каждый локальный ранг. Для локального индекса `i`: `port = --port + i`, `data_parallel_rank = start_rank + i`, где `start_rank = --data-parallel-start-rank` либо `--node-rank × --data-parallel-size-local`.
2. **Раздает карты.** `devices_per_rank = --tensor-parallel-size × --pipeline-parallel-size`; ребенок получает срез `--device-ids[i·devices_per_rank : (i+1)·devices_per_rank]`, а если `--device-ids` не задан — просто `range(start, stop)`. Значения остаются относительными к унаследованному `CUDA_VISIBLE_DEVICES`.
3. **Опрашивает `/health` детей** по loopback с интервалом `--dp-supervisor-probe-interval-s`, таймаутом `--dp-supervisor-probe-timeout-s` и порогом `--dp-supervisor-probe-failure-threshold`. При `--host 0.0.0.0` пробы идут на `127.0.0.1`, при `--host ::` — на `::1`; TLS-проверка сертификата для проб отключена.
4. **Поднимает свой HTTP-сервер** на `--data-parallel-supervisor-port` **только после** того, как все дети ответили `200` — чтобы внешние пробы не видели 503 во время загрузки моделей. Отдает `/health`, `/ready`, `/readyz`.
5. **Роняет все**, если хоть один ребенок умер или после готовности провалил пробу: рассылает SIGTERM/SIGINT, ждет `--shutdown-timeout` плюс 5 секунд, затем убивает дерево процессов.

Имена процессов — `APIServer_DPRank_<rank>`, логи детей помечаются `APIServer_DP<rank>`.

## Значения и формат

- Булев флаг без значения.
- `--data-parallel-size ≥ 2`, `--data-parallel-size-local ≥ 2`, `--data-parallel-size` должен делиться на `--data-parallel-size-local`, и `start_rank + local ≤ dp_size`.
- HTTP-порты детей занимают диапазон `[--port, --port + local − 1]`; `--data-parallel-supervisor-port` не должен в него попадать.
- Несовместим с `--grpc`, `--uds`, явным `--data-parallel-rank`, `--data-parallel-external-lb`, `--data-parallel-hybrid-lb` и с `--api-server-count` больше 1.
- `--ssl-keyfile` и `--ssl-certfile` задаются только парой.

## Когда использовать

- Когда external LB нужен, но плодить по одной команде запуска на ранг неудобно: типовой случай — один под/юнит на узел с несколькими GPU и внешним роутером перед ним.
- Когда балансировщику нужен один агрегированный health-эндпоинт узла, а не N отдельных.
- Не используйте, если ранги узла должны выключаться независимо: супервизор устроен по принципу «все или ничего» — смерть одного ребенка гасит узел.
- Не используйте на одном ранге: минимум `--data-parallel-size-local 2`.

## Влияние на производительность и память

Сам супервизор почти ничего не стоит: это отдельный процесс с FastAPI-приложением из трех обработчиков и периодическими HTTP-пробами. Потребление задается детьми — на узле оказывается `--data-parallel-size-local` полноценных инстансов vLLM, каждый со своими весами и KV-cache.

## Взаимодействие с другими аргументами

- `--data-parallel-size-local`: число детей; `≥ 2` и делитель `--data-parallel-size`.
- `--data-parallel-start-rank` / `--node-rank`: определяют, с какого ранга начинается узел.
- `--port`: база диапазона портов детей.
- `--data-parallel-supervisor-port`: порт агрегированного health; по умолчанию 9256, не должен пересекаться с диапазоном детей.
- `--dp-supervisor-probe-interval-s`, `--dp-supervisor-probe-timeout-s`, `--dp-supervisor-probe-failure-threshold`: параметры проб.
- `--device-ids`: если задан, режется по рангам; длины должно хватить на `local × tp × pp` карт.
- `--tensor-parallel-size`, `--pipeline-parallel-size`: определяют, сколько карт достается одному рангу.
- `--api-server-count`: допустимо только `1` (или пропуск).
- `--data-parallel-rank`, `--data-parallel-external-lb`, `--data-parallel-hybrid-lb`, `--grpc`, `--uds`: несовместимы.

## Типовые проблемы и диагностика

- **Симптом:** `Error: --data-parallel-multi-port-external-lb requires --data-parallel-size-local >= 2`. **Лечение:** либо поднять локальный размер, либо перейти на обычный external LB.
- **Симптом:** `Error: --data-parallel-size must be divisible by --data-parallel-size-local`. **Лечение:** выровнять раскладку узлов.
- **Симптом:** `Error: --data-parallel-supervisor-port 9256 overlaps with child rank ports 9255-9257`. **Лечение:** развести `--port` и `--data-parallel-supervisor-port`.
- **Симптом:** `Error: multi-port supervised ranks would exceed --data-parallel-size`. **Причина:** `--node-rank`/`--data-parallel-start-rank` дают смещение за пределы диапазона. **Лечение:** пересчитать смещение.
- **Симптом:** `ValueError: --device-ids has N entries, but DP rank K needs devices [start, stop)`. **Лечение:** перечислить в `--device-ids` ровно `local × tp × pp` карт.
- **Симптом:** узел «мигает» и выключается целиком. **Причина:** после готовности провалилась проба одного из детей — `DPSupervisor probe found %s unhealthy DP Servers.`, затем `DPSupervisor forwarding SIGTERM to DP Servers.` **Лечение:** искать причину в логах конкретного `APIServer_DP<rank>`; при медленных ответах поднять `--dp-supervisor-probe-timeout-s` и порог.
- **Подтверждение принятого значения:** в логе `Launching vLLM DP Servers`, `Waiting for vLLM DP Servers to become ready.` и `Started DPSupervisor on %s:%d`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 4 --data-parallel-multi-port-external-lb --port 8000 --data-parallel-supervisor-port 9256
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 8 --data-parallel-size-local 4 --data-parallel-start-rank 4 --data-parallel-multi-port-external-lb --device-ids "0,1,2,3" --port 8000
```

## Источники

- `vllm/vllm/entrypoints/openai/dp_supervisor.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/tests/entrypoints/openai/test_dp_supervisor.py`
- `vllm/docs/serving/data_parallel_deployment.md`
