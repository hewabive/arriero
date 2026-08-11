---
schema: 1
engine: sglang
primaryName: "--nccl-port"
title: "--nccl-port"
summary: Фиксирует TCP-порт рандеву `torch.distributed` вместо случайного свободного. Нужен, когда порт надо открыть в firewall или зарезервировать под несколько экземпляров на одном хосте.
group: parallel
related:
  - --dist-init-addr
  - --dist-timeout
  - --nnodes
  - --node-rank
  - --tp-size
  - --dp-size
  - --enable-dp-attention
  - --port
  - --host
  - --use-ray
---

# --nccl-port

## Кратко

`--nccl-port` задает порт TCPStore, через который ранги находят друг друга при инициализации `torch.distributed`. Не задан — `PortArgs.init_new` берет случайный свободный порт (`get_free_port()`). Порт нужен закрепить в двух случаях: многоузловой запуск за firewall и несколько экземпляров на одном хосте, где случайный выбор может однажды пересечься с чужим слушателем. Обратите внимание, что при `--dist-init-addr` адрес рандеву берется оттуда, и этот аргумент перестает быть источником порта.

## Оригинальная справка

```text
The port for NCCL distributed environment setup. Defaults to a random port.
```

## Паспорт аргумента

- Флаги: `--nccl-port`
- Группа: `parallel`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: обычный TCP-порт. Диапазон проверяется только косвенно, в `wait_port_available` (`ValueError: <name> has invalid port number …. Valid TCP port range is 0-65535.`), и только на пути DP-attention
- Значение по умолчанию: `null` — «случайный свободный»
- Эффективное значение: `PortArgs.init_new` подставляет `get_free_port()`. При `--enable-dp-attention` все DP-ранги принудительно используют один и тот же `nccl_port` (`rank_port_args.nccl_port = port_args.nccl_port` в `data_parallel_controller.py`) — «Data parallelism reuses the tensor parallelism group, so all dp ranks should use the same nccl port»
- Где объявлен: `ServerArgs.nccl_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `PortArgs.init_new` (до запуска процессов) → `init_torch_distributed` / `_resolve_dist_init_method`

## Что меняет в движке

### Как из порта получается адрес рандеву

`_resolve_dist_init_method` (`sglang/python/sglang/srt/distributed/bootstrap.py`) выбирает источник по приоритету:

1. переменная `SGLANG_DISTRIBUTED_INIT_METHOD_OVERRIDE` (например, `env://` для внешнего оркестратора) — тогда SGLang не биндит ни `dist_init_port`, ни `nccl_port` вовсе;
2. `--dist-init-addr` — адрес берется целиком из него;
3. иначе — `tcp://<--host или 127.0.0.1>:<nccl_port>`.

То есть на одноузловом запуске `--nccl-port` определяет реальный порт рандеву, а на многоузловом обычно вытесняется `--dist-init-addr`.

### Проверка занятости

Проверка доступности порта выполняется **только** в ветке DP-attention `PortArgs.init_new`: там вызывается `wait_port_available(nccl_port, "nccl_port")`, и при неудаче в лог уходит `Port is already in use. dist_init_port=… port_base=… detokenizer_port=… nccl_port=… scheduler_input_port=…`. В обычной (IPC) ветке заданный порт не проверяется — конфликт проявится позже, ошибкой привязки TCPStore.

`wait_port_available` ждет до `SGLANG_WAIT_PORT_TIMEOUT` секунд (по умолчанию 30): убитый сервер может держать порты уже после возврата `kill_process_tree`, пока идет освобождение GPU.

### Дополнительные потребители

- Демоны кеша весов (`--weight-cache-mode daemon`) намеренно **не** используют `--nccl-port`: для собственного рандеву они берут свежий свободный порт, потому что «a pinned `--nccl-port` would otherwise collide with the engine's own NCCL TCPStore».
- В Ray-режиме адрес рандеву собирается как `<ip ранга 0>:<nccl_port>` и печатается строкой `dist_init_addr: …`.
- Encode-серверы дезагрегации биндят `port_args.nccl_port` на своем хосте.

## Значения и формат

- Целое, обычный порт. Задавайте выше 1024, чтобы не требовать привилегий.
- Не задавать — и есть «случайный»; значения `0` как «авто» не предусмотрено, оно будет принято как настоящий порт.
- Порт должен быть **одинаковым** на всех узлах многоузлового запуска, если рандеву идет через него (то есть когда `--dist-init-addr` не задан).
- Не должен совпадать с `--port` HTTP-сервера, `--grpc-port` и портами метрик. Проверки этого движок не делает: в `check_server_args` сверяются только `--grpc-port` и `--port`, а сравнение с `nccl_port` и портом метрик оставлено на будущее — их умолчания вычисляются позже и на момент проверки еще не разрешены.
- В режиме DP-attention от `dist_init_port` дополнительно отсчитывается блок производных портов (`port_base`, detokenizer, rpc, metrics и др.) — планируйте диапазон, а не один номер.

## Когда использовать

- Многоузловой запуск, где firewall требует заранее известный порт, а `--dist-init-addr` по каким-то причинам не используется.
- Несколько экземпляров на одном хосте: закрепите разные порты явно, чтобы гарантированно исключить пересечение вместо надежды на случайный выбор.
- Автоматизированный деплой, где порт должен быть детерминированным (проброс в контейнер, описание сервиса).
- Не задавать на обычном одиночном запуске: случайный свободный порт надежнее закрепленного.
- Не задавать вместе с `--dist-init-addr`, ожидая, что рандеву пойдет по нему: адрес из `--dist-init-addr` выигрывает.

## Влияние на производительность и память

- На производительность и память не влияет: порт используется только для рандеву при инициализации групп. После установки соединений трафик идет по каналам NCCL.
- Влияние на старт — только отрицательное и только при конфликте: `wait_port_available` может ждать до 30 секунд, прежде чем отказать.

## Взаимодействие с другими аргументами

- `--dist-init-addr` (алиас `--nccl-init-addr`): при заданном адресе перекрывает этот аргумент как источник точки рандеву.
- `--dist-timeout`: определяет, сколько ранги ждут сбора группы после того, как адрес разрешен.
- `--nnodes` / `--node-rank`: значение должно совпадать на всех узлах.
- `--enable-dp-attention`: включает TCP-режим межпроцессного обмена, единый `nccl_port` для всех DP-рангов и проверку занятости портов.
- `--port` / `--grpc-port`: не должны совпадать; автоматической проверки нет.
- `--use-ray`: порт входит в собираемый `dist_init_addr`.

## Типовые проблемы и диагностика

- `Port is already in use. dist_init_port=… nccl_port=… …` — порт занят (путь DP-attention). Освободите порт или задайте другой.
- Старт зависает на `Init torch distributed begin.` без парной строки `Init torch distributed ends.` — ранги не собрались: разные порты на узлах, закрытый firewall или неверный `--dist-init-addr`. Смежная ручка — `--dist-timeout`.
- Конфликт с демоном кеша весов невозможен по построению: он берет отдельный свободный порт.
- Порт задан, но рандеву идет на другой — задан `--dist-init-addr` либо переменная `SGLANG_DISTRIBUTED_INIT_METHOD_OVERRIDE`.
- Что смотреть в логе: `nccl_port=` в дампе `server_args=`, `dist_init_addr: …` (Ray-режим), `Init torch distributed begin.` / `Init torch distributed ends. elapsed=… s`, а на хосте — `ss -ltnp | grep <порт>`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --nccl-port 27000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --port 30001 --tensor-parallel-size 2 --nccl-port 27100 --dist-timeout 1800
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/utils/network.py`
- `sglang/python/sglang/srt/ray/engine.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
