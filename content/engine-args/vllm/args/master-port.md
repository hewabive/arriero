---
schema: 1
engine: vllm
primaryName: "--master-port"
title: "--master-port"
summary: TCP-порт рандеву torch.distributed на головном узле многоузлового mp-запуска, по умолчанию 29501. Не путать с портами DP-контура (29500 и 29550) и с `--port` HTTP-сервера.
group: ParallelConfig
related:
  - --master-addr
  - --nnodes
  - --node-rank
  - --headless
  - --data-parallel-rpc-port
  - --port
  - --distributed-timeout-seconds
---

# --master-port

## Кратко

`--master-port` — порт, на котором головной узел поднимает `TCPStore` для инициализации `torch.distributed`. Вместе с `--master-addr` он образует `distributed_init_method` и читается ровно там же: только при `--nnodes > 1`.

У vLLM несколько независимых портовых контуров, и их легко перепутать. Этот флаг — про TP/PP-мир. У data parallelism свои: `data_parallel_master_port` (29500) и `--data-parallel-rpc-port` (29550). HTTP-порт API-сервера — это `--port`.

## Оригинальная справка

```text
distributed master port for multi-node distributed 
inference when distributed_executor_backend is mp.
```

## Паспорт аргумента

- Флаги: `--master-port`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `choices` нет и pydantic-границ у поля тоже нет — в отличие от `data_parallel_rpc_port` (`Field(default=29550, ge=1, le=65535)`), диапазон здесь не проверяется. Ошибочное значение проявится при попытке привязки сокета
- Значение по умолчанию: `29501`
- Эффективное значение: не переопределяется. Читается только при `nnodes > 1` (и при backend'е, отличном от `external_launcher`, вне elastic EP). Исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.master_port`
- Этап применения: `init_distributed_environment` (построение `distributed_init_method`) и запуск headless-узла в `vllm serve`

## Что меняет в движке

Ровно то же, что `--master-addr`, — вторая половина адреса рандеву. `init_distributed_environment` при `nnodes > 1` строит `distributed_init_method = get_distributed_init_method(master_addr, master_port)`; headless-узел печатает `head_node_address = f"{master_addr}:{master_port}"` и подключается туда.

Соседние порты, с которыми этот флаг никак не связан:

- `data_parallel_master_port` (дефолт 29500) — порт групп процессов data parallelism. При `data_parallel_size > 1` и без elastic EP движок заранее резервирует пять свободных портов (`get_open_ports_list(5)`) и раздаёт их через `get_next_dp_init_port()`, поэтому фактические порты DP обычно не равны 29500.
- `--data-parallel-rpc-port` (дефолт 29550, с проверкой `1..65535`) — общий для всех узлов порт обмена сообщениями DP.
- `--port` — HTTP-порт OpenAI-совместимого API.

## Значения и формат

- Целое. Валидации диапазона в конфиге нет; значение уходит прямо в адрес TCP-сокета.
- `29501` (дефолт) выбран так, чтобы не пересекаться с `29500` (DP-мастер). Если вы поднимаете несколько многоузловых запусков на одних и тех же машинах, порты обязаны различаться.
- Значение обязано совпадать на всех узлах запуска.
- Порт должен быть открыт между узлами: слушает только головной узел, подключаются все остальные.

## Когда использовать

- **При конфликте портов.** Единственная штатная причина менять дефолт: на машине уже занят 29501 (другой инстанс vLLM, другой распределённый запуск).
- **При нескольких многоузловых инстансах на общем парке машин.** Каждому — свой порт.
- **Не меняйте «для безопасности».** Смена номера не добавляет защиты: `TCPStore` не аутентифицирован, и безопасность обеспечивается сетевой сегментацией, а не выбором порта.
- **Не задавайте при однохостовом запуске** — значение не читается.

## Влияние на производительность и память

- **VRAM, throughput, latency.** Прямого влияния нет.
- **Время старта.** Занятый или закрытый порт означает зависание на рандеву до таймаута распределённой инициализации (`--distributed-timeout-seconds`, по умолчанию — 600 секунд для NCCL).
- **Безопасность.** Это единственный аспект, где выбор значения важен. Порт слушает `TCPStore` без аутентификации; трафик между узлами не шифруется, и апстрим-документация предупреждает, что доступ к этой сети может привести к выполнению произвольного кода. Порт нельзя выставлять в недоверенную сеть.

## Взаимодействие с другими аргументами

- `--master-addr`: первая половина адреса рандеву.
- `--nnodes`: значение читается только при `> 1`.
- `--node-rank`: слушает узел с рангом 0, остальные подключаются.
- `--headless`: ведомые узлы используют пару адрес:порт как точку подключения.
- `--data-parallel-rpc-port`: другой контур, другой порт; при совпадении номеров будет конфликт привязки.
- `--port`: HTTP-порт API-сервера; тоже должен отличаться.
- `--distributed-timeout-seconds`: сколько ждать при недоступном порте.

## Типовые проблемы и диагностика

- **Симптом:** `torch.distributed.DistNetworkError: ... EADDRINUSE` на головном узле. **Причина:** порт занят. **Лечение:** выбрать свободный номер и задать его одинаково на всех узлах.
- **Симптом:** ведомые узлы висят, головной стартовал. **Причина:** порт закрыт фильтром между машинами. **Проверка:** подключение к `master_addr:master_port` с ведомого узла обычными сетевыми средствами.
- **Симптом:** запуск двух многоузловых инстансов на одних машинах: второй не поднимается. **Причина:** совпадающие `--master-port`. **Лечение:** развести номера.
- **Симптом:** в логе адрес рандеву не тот, что вы задали. **Причина:** `--nnodes` равен 1, и используется file-store вместо TCP. **Проверка:** строка `world_size=... distributed_init_method=...`.
- **Подтверждение принятого значения:** на ведомом узле строка `Launching vLLM (v...) headless multiproc executor, with head node address <addr>:<port> for torch.distributed process group.`

## Примеры

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --nnodes 2 --node-rank 0 --master-addr 192.168.1.100 --master-port 31501
```

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 8 --pipeline-parallel-size 2 --nnodes 2 --node-rank 1 --master-addr 192.168.1.100 --master-port 31501 --headless
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/parallel_state.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/utils/network_utils.py`
- `vllm/docs/serving/parallelism_scaling.md`
