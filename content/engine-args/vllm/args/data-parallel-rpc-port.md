---
schema: 1
engine: vllm
primaryName: "--data-parallel-rpc-port"
title: "--data-parallel-rpc-port"
summary: TCP-порт рукопожатия DP-рангов на головном узле. Одинаков на всех узлах развертывания; при единственном узле не используется вовсе, потому что рукопожатие идет по IPC.
group: ParallelConfig
related:
  - --data-parallel-address
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-rank
  - --data-parallel-start-rank
  - --data-parallel-backend
  - --master-port
  - --port
  - --headless
---

# --data-parallel-rpc-port

## Кратко

`--data-parallel-rpc-port` — порт ZMQ-канала, на котором ранг 0 принимает `HELLO`/`READY` от остальных DP-рангов и рассылает им адреса. Справка про это молчит, но значение должно быть **буквально одинаковым на всех узлах**: каждый узел строит из него один и тот же URI `tcp://<data-parallel-address>:<rpc-port>` — голова биндит на нем ROUTER-сокет, headless-узел по нему подключается.

Это не HTTP-порт (`--port`) и не порт torch-группы (`--master-port`).

## Оригинальная справка

```text
Port for data parallel RPC communication.
```

## Паспорт аргумента

- Флаги: `--data-parallel-rpc-port`, `-dpp`
- Группа argparse: `ParallelConfig`
- Тип значения: int (номер TCP-порта)
- Допустимые значения: любое целое — диапазон на поле `ParallelConfig.data_parallel_rpc_port` не валидируется
- Значение по умолчанию: в объявлении CLI отсутствует (argparse подставляет `None`)
- Эффективное значение: при `None` `create_engine_config` подставляет дефолт датакласса `ParallelConfig.data_parallel_rpc_port = 29550`, то есть **29550**
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: `create_engine_config` → `ParallelConfig.data_parallel_rpc_port` → построение адреса рукопожатия при запуске engine-процессов

## Что меняет в движке

`launch_core_engines` вычисляет `handshake_local_only = (local_engine_count == dp_size)` и вызывает `get_engine_client_zmq_addr(handshake_local_only, host, data_parallel_rpc_port)`:

- **все ранги локальные** → возвращается путь IPC-сокета, порт не читается;
- **есть удаленные ранги** → `tcp://<data_parallel_master_ip>:<rpc_port>`, на котором ранг 0 биндит ROUTER-сокет.

В external-LB режиме ранги `> 0` дополнительно поднимают локальный IPC-сокет для своего движка, но с фронтендом ранга 0 общаются по этому TCP-адресу.

Порт входит в `ignored_factors` `ParallelConfig.compute_hash()` — рассинхрон значения между узлами не даст ошибки «конфигурации разошлись», он проявится зависанием рукопожатия.

## Значения и формат

- Целое — номер TCP-порта; диапазон не валидируется, некорректный номер проявится только ошибкой bind/connect.
- `0` заставляет головной узел выбрать свободный порт при старте (`data_parallel_rpc_port or get_open_port()` в `launch_core_engines`). В многоузловом развертывании это бесполезно: headless-узел подставляет свое значение прямо в адрес подключения и про выбранный головой порт не узнает.
- Пропуск флага равен `29550`. Дефолт не «свободный порт», а фиксированный номер, поэтому два независимых многоузловых развертывания на одном головном IP столкнутся на нем.
- Порт нужен ровно один — он общий для всего развертывания, а не по одному на ранг. Индивидуальны только HTTP-порты (`--port`).
- Порты самой DP-группы `torch.distributed` этим флагом не задаются: голова выбирает пять свободных портов (`get_open_ports_list(5)`) и раздает их рангам в init-сообщении.

## Когда использовать

- На всех узлах многоузлового DP-развертывания — вместе с `--data-parallel-address`.
- Когда на головном узле уже занят порт 29550 или когда на одном IP живет несколько развертываний: задайте разные значения каждому.
- Не нужен на одноузловом развертывании: там канал IPC-шный.
- Не нужен при `--data-parallel-backend ray` — документация vLLM явно отмечает, что для Ray порт указывать не требуется.

## Влияние на производительность и память

Не влияет: канал служебный, по нему идут только рукопожатие и управляющие сообщения. Значим лишь факт доступности порта между узлами.

## Взаимодействие с другими аргументами

- `--data-parallel-address`: вторая половина адреса; оба задаются вместе.
- `--data-parallel-size-local`: пока он равен `--data-parallel-size`, порт не используется.
- `--data-parallel-rank`: co-located ранги в external LB делят общий RPC-порт и различаются `--port`.
- `--master-port`: отдельный порт torch-группы TP/PP при `mp`; путать их не надо.
- `--data-parallel-backend ray`: делает флаг избыточным.

## Типовые проблемы и диагностика

- **Симптом:** голова бесконечно печатает `Waiting for %d local, %d remote core engine proc(s) to connect.` **Причина:** у вторичного узла другой порт либо порт закрыт файрволом. **Лечение:** одинаковое значение на всех узлах плюс правило файрвола; таймаута у ожидания нет.
- **Симптом:** `zmq.error.ZMQError: Address already in use` при старте головы. **Причина:** порт занят другим развертыванием или зависшим процессом. **Лечение:** выбрать другой номер или добить старый процесс.
- **Симптом:** развертывания «перепутались» — ранг подключился не туда. **Причина:** совпали `--data-parallel-address` и порт у двух разных развертываний. **Лечение:** развести порты.
- **Подтверждение принятого значения:** на headless-узле в логе `Launching %d data parallel engine(s) in headless mode, with head node address %s.` — в адресе виден `host:port`.
- **Безопасность:** канал не аутентифицирован; порт нельзя выставлять в недоверенную сеть (`docs/usage/security.md`).

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 2 --data-parallel-rank 1 --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345 --port 8000
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/v1/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
- `vllm/docs/usage/security.md`
