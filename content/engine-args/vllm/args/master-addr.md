---
schema: 1
engine: vllm
primaryName: "--master-addr"
title: "--master-addr"
summary: Адрес головного узла для рандеву torch.distributed в многоузловом mp-запуске. По умолчанию `127.0.0.1`, то есть за пределы машины ничего не выходит; для реального многоузлового запуска обязателен адрес узла с `--node-rank 0`.
group: ParallelConfig
related:
  - --master-port
  - --nnodes
  - --node-rank
  - --headless
  - --distributed-executor-backend
  - --data-parallel-address
  - --distributed-timeout-seconds
---

# --master-addr

## Кратко

`--master-addr` — это IP или имя головного узла (`--node-rank 0`), на котором слушает `TCPStore` инициализации `torch.distributed`. Значение читают только два места: построение `distributed_init_method` при `nnodes > 1` и вычисление адреса головного узла для headless-узлов.

Оно должно совпадать на всех машинах запуска. Дефолт `127.0.0.1` пригоден только для однохостового запуска — при `--nnodes > 1` его нужно заменить на адрес, видимый всем узлам.

## Оригинальная справка

```text
distributed master address for multi-node distributed 
inference when distributed_executor_backend is mp.
```

## Паспорт аргумента

- Флаги: `--master-addr`
- Группа argparse: `ParallelConfig`
- Тип значения: str (IP-адрес или разрешаемое имя хоста)
- Допустимые значения: `choices` нет; формат не валидируется, ошибка проявится при попытке подключения
- Значение по умолчанию: `"127.0.0.1"`
- Эффективное значение: не переопределяется. Читается только при `nnodes > 1` (и при backend'е, отличном от `external_launcher`, вне elastic EP); во всех остальных случаях рандеву идёт через file-store или loopback. Исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.master_addr`
- Этап применения: `init_distributed_environment` (построение `distributed_init_method`) и запуск headless-узла в `vllm serve`

## Что меняет в движке

**Рандеву.** `vllm/distributed/parallel_state.py:init_distributed_environment` при `nnodes > 1` строит `distributed_init_method = get_distributed_init_method(master_addr, master_port)`. Без этого условия используется file-store (`get_file_store_init_method()`), то есть локальный путь, недоступный другим машинам.

**Headless-узлы.** `vllm/entrypoints/cli/serve.py` при `node_rank_within_dp > 0` печатает `head_node_address = f"{master_addr}:{master_port}"` и поднимает `MultiprocExecutor` без API-сервера.

**Прочие потребители.** Значение читает Mooncake KV-коннектор (`vllm/distributed/kv_transfer/kv_connector/v1/mooncake/mooncake_connector.py`) как адрес хоста. К DP-контуру этот флаг отношения не имеет: там свои `--data-parallel-address` и `--data-parallel-rpc-port`.

## Значения и формат

- Строка. Обычно IPv4-адрес головного узла; допустимо имя хоста, если оно разрешается одинаково на всех машинах.
- `127.0.0.1` (дефолт) означает «только эта машина». При `--nnodes > 1` это приведёт к тому, что ведомые узлы будут стучаться в собственный loopback и никогда не найдут лидера.
- Значение обязано быть идентичным во всех командах запуска.
- Проверок формата нет: опечатка проявится как зависание на инициализации process group, а не как ошибка конфигурации.

## Когда использовать

- **Всегда при `--nnodes > 1`.** Без явного адреса многоузловой mp-запуск не соберётся.
- **Не задавайте при однохостовом запуске.** Значение не читается, а иллюзию «я настроил сеть» создаёт.
- **Выбирайте адрес приватного сегмента.** Апстрим-документация прямо предупреждает: трафик между узлами не шифруется, а формат обмена таков, что при доступе злоумышленника к сети возможно выполнение произвольного кода. Слушающий на публичном интерфейсе `TCPStore` — это открытый вход в кластер.
- **Не путайте с `--data-parallel-address`**: тот адресует DP-координатор, этот — рандеву TP/PP-мира.

## Влияние на производительность и память

- **VRAM, throughput.** Прямого влияния нет: это адрес рандеву, а не путь данных стационарного режима.
- **Время старта.** Определяет, состоится ли рандеву вообще. Неверный адрес — зависание до таймаута (по умолчанию 600 секунд для NCCL; настраивается `--distributed-timeout-seconds`).
- **Косвенно.** Через какой интерфейс пойдёт NCCL, задаёт не этот флаг, а переменные окружения (`NCCL_SOCKET_IFNAME`, `GLOO_SOCKET_IFNAME`, `VLLM_HOST_IP`). Адрес рандеву и транспорт коллективов — разные вещи.

## Взаимодействие с другими аргументами

- `--master-port`: вторая половина адреса рандеву.
- `--nnodes`: значение читается только при `> 1`.
- `--node-rank`: адрес должен указывать на узел с рангом 0.
- `--headless`: ведомые узлы используют этот адрес как точку подключения.
- `--distributed-executor-backend`: при `external_launcher` рандеву организует внешний лаунчер, флаг не читается.
- `--distributed-timeout-seconds`: сколько ждать, если по этому адресу никого нет.
- `--data-parallel-address`, `--data-parallel-rpc-port`: отдельный контур DP, этим флагом не управляется.

## Типовые проблемы и диагностика

- **Симптом:** все узлы запустились, но висят до загрузки модели. **Причина:** неверный или недостижимый `--master-addr`, закрытый порт, разные значения на узлах. **Проверка:** строка `world_size=%d rank=%d local_rank=%d distributed_init_method=%s backend=%s` в логе каждого узла — в ней виден фактический адрес рандеву.
- **Симптом:** на ведомом узле `Launching vLLM (v...) headless multiproc executor, with head node address 127.0.0.1:29501 ...` **Причина:** `--master-addr` не задан. **Лечение:** указать адрес головного узла.
- **Симптом:** `torch.distributed.DistNetworkError` при подключении. **Причина:** сетевой фильтр между узлами или занятый порт. **Лечение:** открыть `--master-port`, проверить доступность адреса с ведомого узла.
- **Симптом:** межузловые коллективы работают, но медленно. **Причина:** это уже не про адрес рандеву — NCCL выбрал TCP-сокет вместо InfiniBand. **Проверка:** `NCCL_DEBUG=TRACE` и поиск `[send] via NET/IB/GDRDMA` против `[send] via NET/Socket`.
- **Подтверждение принятого значения:** на лидере `DP group leader: node_rank=..., master_addr=<адрес>, mq_connect_ip=... (local), ...`.

## Примеры

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --nnodes 2 --node-rank 0 --master-addr 192.168.1.100 --master-port 29501
```

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --nnodes 2 --node-rank 1 --master-addr 192.168.1.100 --master-port 29501 --headless
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/docs/serving/parallelism_scaling.md`
- `vllm/docs/serving/distributed_troubleshooting.md`
