---
schema: 1
engine: vllm
primaryName: "--data-parallel-address"
title: "--data-parallel-address"
summary: IP головного узла DP-развертывания (ранга 0). Одно и то же значение задается на всех узлах; по этому адресу поднимается неаутентифицированный ZMQ-сокет рукопожатия и torch-группа DP.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-rpc-port
  - --data-parallel-rank
  - --data-parallel-start-rank
  - --data-parallel-backend
  - --master-addr
  - --master-port
  - --headless
  - --nnodes
---

# --data-parallel-address

## Кратко

`--data-parallel-address` — это адрес ранга 0, к которому подключаются все остальные ранги. Значение обязано **совпадать на всех узлах** одного DP-развертывания и должно быть реально достижимым с них (не `127.0.0.1`, если узлов больше одного).

На одноузловом развертывании флаг не нужен: когда все ранги локальные, рукопожатие идет по IPC-сокету, а не по TCP.

## Оригинальная справка

```text
Address of data parallel cluster head-node.
```

## Паспорт аргумента

- Флаги: `--data-parallel-address`, `-dpa`
- Группа argparse: `ParallelConfig`
- Тип значения: str (IP-адрес или имя хоста)
- Допустимые значения: не ограничены; строка передается как есть в `tcp://<host>:<port>` и в `torch.distributed`
- Значение по умолчанию: в объявлении отсутствует — argparse подставляет `None`
- Эффективное значение: при `None` и `--data-parallel-backend ray` берется локальный IP (`get_ip()`, лог `Using host IP %s as ray-based data parallel address`); при `mp` — `--master-addr`, а если и он не задан, то `ParallelConfig.data_parallel_master_ip = "127.0.0.1"`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: `create_engine_config` → `ParallelConfig.data_parallel_master_ip` → рукопожатие engine-процессов, инициализация DP process group, координационный TCPStore

## Что меняет в движке

Значение уходит в `ParallelConfig.data_parallel_master_ip` и используется тремя подсистемами:

1. **ZMQ-рукопожатие.** `get_engine_client_zmq_addr(local_only, host, rpc_port)` строит `tcp://<address>:<data-parallel-rpc-port>`, на котором ранг 0 биндит ROUTER-сокет, а удаленные движки — свои сокеты. Если `data_parallel_size_local == data_parallel_size`, `local_only` истинно и TCP не используется вовсе.
2. **DP process group.** `stateless_init_dp_group()` поднимает gloo-группу на `(data_parallel_master_ip, порт из _data_parallel_master_port_list)`. Эти порты выбираются на голове автоматически (`get_open_ports_list(5)`) и рассылаются остальным рангам в init-сообщении вместе с `data_parallel_master_port` и `data_parallel_size` — их тоже надо открыть между узлами, и в CLI они не задаются.
3. **Координационный TCPStore.** `_pick_stateless_dp_port()` при наличии `_coord_store_port` биндит сокет на `data_parallel_master_ip` и публикует порт через `get_cached_tcp_store_client(...)`.

Поле `data_parallel_master_ip` входит в `ignored_factors` `ParallelConfig.compute_hash()`, поэтому расхождение адреса не даст осмысленной ошибки «конфигурации разошлись» — оно проявится зависанием на рукопожатии.

## Значения и формат

- Строка `host` без схемы и порта: `10.99.48.128`, `dp-head.internal`. Порт задается отдельно (`--data-parallel-rpc-port`).
- Значение по умолчанию `127.0.0.1` работает только когда все ранги на одной машине.
- Для `--data-parallel-backend ray` флаг не нужен: адресом становится узел, с которого запущена команда.
- Альтернатива для `mp`: задать `--master-addr` — при отсутствии `--data-parallel-address` он используется как DP-адрес (и одновременно как адрес torch-группы TP/PP).

## Когда использовать

- На всех узлах многоузлового DP-развертывания с `mp`-бэкендом, включая головной: голова должна биндиться на маршрутизируемый адрес, а не на loopback.
- В external-LB раскладке с рангами на разных машинах — там ранги `> 0` подключаются к фронтенду ранга 0 по этому адресу.
- Не нужен, если все ранги на одном хосте (в том числе для co-located external LB: там `--data-parallel-rpc-port` берется по умолчанию, а адрес — `127.0.0.1`).

## Влияние на производительность и память

На VRAM и throughput не влияет: это только адрес управляющего канала. Значимо одно — сетевая достижимость: рукопожатие ждет подключений без таймаута, поэтому неверный адрес выглядит как «сервер не стартовал», а не как ошибка.

## Взаимодействие с другими аргументами

- `--data-parallel-rpc-port`: пара «адрес + порт» рукопожатия; оба должны совпадать на всех узлах.
- `--master-addr` / `--master-port`: адрес и порт torch-группы для TP/PP при `mp`; `--master-addr` подменяет DP-адрес, если тот не задан.
- `--data-parallel-size-local`: пока он равен `--data-parallel-size`, адрес не используется.
- `--data-parallel-backend`: при `ray` адрес вычисляется автоматически.
- `--headless`: headless-узлы подключаются именно по этому адресу.

## Типовые проблемы и диагностика

- **Симптом:** узлы не соединяются, голова печатает `Waiting for %d local, %d remote core engine proc(s) to connect.` бесконечно. **Причина:** голова забиндилась на `127.0.0.1` либо у вторичных узлов другой адрес. **Лечение:** задать один и тот же маршрутизируемый IP на всех узлах.
- **Симптом:** `torch.distributed.DistNetworkError` с `EADDRINUSE`. **Причина:** порт DP-группы занят. **Действие:** vLLM сам логирует `Address already in use. Retrying with a new port.` и повторяет до пяти раз; если ошибка сохраняется, освободить диапазон портов на головном узле.
- **Симптом:** ранги видят друг друга, но коллективы падают по таймауту. **Причина:** адрес достижим, а автоматически выбранные порты DP-группы закрыты. **Лечение:** открыть их между узлами; при медленной сети поднять `--distributed-timeout-seconds`.
- **Безопасность:** трафик по этому адресу не шифруется и не аутентифицируется — `docs/usage/security.md` прямо требует выносить узлы в изолированную сеть. Никогда не указывайте здесь адрес, доступный из недоверенной сети.
- **Подтверждение принятого значения:** на headless-узле в логе `Launching %d data parallel engine(s) in headless mode, with head node address %s.`; при `ray` — `Using host IP %s as ray-based data parallel address`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/DeepSeek-V2-Lite --headless --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 2 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/v1/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
- `vllm/docs/usage/security.md`
