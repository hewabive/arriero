---
schema: 1
engine: sglang
primaryName: "--dist-init-addr"
title: "--dist-init-addr"
summary: Адрес `host:port`, по которому все ранги собираются в одну distributed-группу. Порт обязателен, строка должна быть одинаковой на всех узлах и указывать на узел с `--node-rank 0`.
group: parallel
related:
  - --nnodes
  - --node-rank
  - --dist-timeout
  - --tp-size
  - --pp-size
  - --dp-size
  - --enable-dp-attention
  - --host
  - --port
  - --elastic-ep-join-mode
  - --elastic-ep-join-rank-offset
---

# --dist-init-addr

## Кратко

`--dist-init-addr` — точка рандеву: `torch.distributed` на каждом ранге подключается к `tcp://<host>:<port>`, пока не соберется группа из `tp_size * pp_size` участников. Строка обязана содержать порт (голое имя хоста отвергается с явной ошибкой) и быть побайтово одинаковой на всех узлах. При включенном DP-attention этот же адрес становится базой для шести производных TCP-портов управляющего слоя, поэтому его выбор перестает быть чисто сетевой формальностью. По умолчанию не задан — на одном узле это нормально, на нескольких это гарантированный дедлок.

## Оригинальная справка

```text
The host address for initializing distributed backend (e.g., `192.168.0.2:25000`).
```

## Паспорт аргумента

- Флаги: `--dist-init-addr`, `--nccl-init-addr`
- Группа: `parallel`
- Тип значения: str (`Optional[str]`), формат `host:port`
- Допустимые значения: `choices` нет. Разбор делает `NetworkAddress.parse` (`utils/network.py`): `127.0.0.1:25000`, `my-host:25000`, `[::1]:25000`. Порт обязателен; IPv6 обязан быть в квадратных скобках, голый `::1:25000` отвергается как неоднозначный
- Значение по умолчанию: `null`
- Эффективное значение: само поле не переписывается, но при незаданном значении подставляются разные умолчания в зависимости от режима (см. ниже). Переменная окружения `SGLANG_DISTRIBUTED_INIT_METHOD_OVERRIDE` перекрывает аргумент целиком — при ней SGLang вообще не биндит `dist_init_port` и `nccl_port` и полагается на внешний store (например `env://` с `MASTER_ADDR`/`MASTER_PORT`)
- Где объявлен: `ServerArgs.dist_init_addr`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `PortArgs.init_new` (вывод служебных портов при DP-attention) → `launch_dp_attention_schedulers` (адрес bind'а воркер-сокетов) → `_resolve_dist_init_method` → `init_distributed_environment` в каждом воркере

## Что меняет в движке

### Рандеву distributed-группы

`distributed/bootstrap.py:_resolve_dist_init_method` выбирает init-метод по трем веткам, в порядке приоритета:

1. `SGLANG_DISTRIBUTED_INIT_METHOD_OVERRIDE`, если задана;
2. `--dist-init-addr` → `tcp://<host>:<port>`;
3. иначе `tcp://<--host или 127.0.0.1>:<nccl_port>`.

Дальше `init_distributed_environment(world_size=tp_size*pp_size, rank=tp_size*pp_rank+tp_rank, distributed_init_method=…)` блокируется, пока все ранги не подключатся. Отсюда главное правило многоузлового запуска: третья ветка на каждом узле даст **свой собственный** адрес, узлы никогда не встретятся, и запуск повиснет на строке `Init torch distributed begin.` до истечения `--dist-timeout`. Поэтому при `--nnodes > 1` адрес обязателен, хотя формально аргумент опционален и никакой проверки на старте нет.

### Производные порты при DP-attention

Без DP-attention межпроцессные сокеты внутри узла — это unix-IPC во временных файлах, и `--dist-init-addr` на них не влияет. При `--enable-dp-attention` `PortArgs.init_new` переходит на TCP и выводит порты из этого адреса:

```
port_base        = dist_init_port + 1   (или dist_init_port − NUM_DERIVED_PORTS − 1 при переполнении 65535)
tokenizer        = port_base
detokenizer      = port_base + 1
rpc              = port_base + 2
metrics          = port_base + 3
scheduler_input  = port_base + 4        (для DataParallelController)
load_collector   = port_base + 5        (только при nnodes > 1)
```

`NUM_DERIVED_PORTS` равен 6 (и `6 + dp_size` под `SGLANG_RUST_SERVER`). Каждый из них проверяется на занятость (`wait_port_available`), и занятый порт валит старт. Если `--dist-init-addr` не задан, а `--nnodes == 1`, база берется как `--port + 233` на `127.0.0.1` (с зеркальным `--port − 233` при переполнении).

Хост из адреса используется и как адрес bind'а: `launch_dp_attention_schedulers` биндит PUSH-сокеты воркеров на `NetworkAddress.parse(dist_init_addr).host`. То есть при DP-attention этот адрес определяет, на каком интерфейсе слушает управляющий слой.

### Elastic EP

Присоединяющаяся группа (`--elastic-ep-join-mode scale`) использует тот же адрес как точку связи с первичным развертыванием: handshake-порт считается как `dist_init_port + 13`, а обратный канал токенизатора — как `dist_init_port + 1` и `+ 2`.

## Значения и формат

- Ровно `host:port`. Голый хост (`--dist-init-addr node0`) падает с `ValueError: Missing port in address (expected host:port): 'node0'` — примеры в апстрим-документации по pipeline parallelism, где стоит `--dist-init-addr <MASTER_NODE_IP>`, требуют дописать порт.
- IPv6 — только `[адрес]:порт`; `NetworkAddress.parse` явно отвергает небракетированную форму с подсказкой.
- Пустая строка отвергается как `Empty address string`.
- Хост может быть DNS-именем: резолв делается через `getaddrinfo`, нерезолвимое имя дает `ValueError: Cannot resolve host …`.
- Порт должен быть свободен на узле `--node-rank 0`, как и производные `port_base…port_base+5` при DP-attention.

## Когда использовать

- Любой запуск с `--nnodes > 1`: обязателен, одинаковый на всех узлах, указывает на узел 0.
- Одноузловой запуск с несколькими экземплярами SGLang на одной машине с DP-attention: задавайте адрес явно, чтобы развести производные порты и не полагаться на `--port ± 233`.
- Нужно ограничить интерфейс, на котором слушает управляющий слой при DP-attention: адрес — единственная ручка для этого.
- Не задавайте на обычном одноузловом запуске без DP-attention: там он ничего не улучшает, а лишний занятый порт добавляет.
- Не используйте `0.0.0.0`: значение уйдет и в bind воркер-сокетов, и в строку подключения `torch.distributed` — как адрес подключения оно бессмысленно.

## Влияние на производительность и память

- На память и throughput не влияет: значение только задает адрес рандеву и базу для служебных портов.
- Косвенно влияет на **время старта**: при недоступном адресе старт висит до `--dist-timeout`, а не падает быстро.
- Косвенно влияет на **пропускную способность коллективов**: выбор интерфейса (например, IPoIB-адрес против управляющего Ethernet) определяет, по какому пути пойдет начальный обмен и, в зависимости от конфигурации NCCL, часть трафика.

## Взаимодействие с другими аргументами

- `--nnodes`: обязателен при значении > 1; топология рангов описана в `nnodes.md`.
- `--node-rank`: адрес одинаков на всех узлах, различает их только ранг.
- `--dist-timeout`: определяет, сколько ранги ждут друг друга по этому адресу.
- `--enable-dp-attention`: включает вывод шести производных TCP-портов из этого адреса и bind воркер-сокетов на его хост.
- `--port` / `--host`: при незаданном адресе и `nnodes == 1` база портов DP-attention считается как `--port ± 233`; в третьей ветке `_resolve_dist_init_method` используется `--host`.
- `--elastic-ep-join-mode scale` / `--elastic-ep-join-rank-offset`: присоединяющаяся группа подключается к адресу первичного развертывания.
- `--weight-cache-mode daemon`: при `nnodes > 1` требует заданного `--dist-init-addr` (`Multi-node weight cache daemons (nnodes > 1) require …`).
- Алиас `--nccl-init-addr` — то же поле; исторически имя намекало на NCCL, но адрес используется всем distributed-слоем, а при DP-attention еще и ZMQ.

## Типовые проблемы и диагностика

- `ValueError: Missing port in address (expected host:port): 'node0'` — забыт порт.
- `ValueError: Bare IPv6 address without brackets is ambiguous: '::1:25000'. Use [::1]:25000 instead.` — IPv6 без скобок.
- `ValueError: Cannot resolve host 'node0': …` — имя не резолвится с этого узла.
- Старт висит на `Init torch distributed begin.` — часть рангов не подключилась: разный адрес на узлах, закрытый порт, неверный `--nnodes`, лишний или недостающий узел. Проверьте, что строка совпадает символ в символ, и что на узле 0 порт слушается.
- `Port is already in use. dist_init_port=… port_base=… detokenizer_port=… nccl_port=… scheduler_input_port=…` — при DP-attention занят один из производных портов; сдвиньте адрес или `--port`.
- Запущены два экземпляра на одном хосте, второй падает по портам — производные порты выводятся из одного и того же `--port ± 233`, если адрес не задан явно.
- **Безопасность.** Управляющие ZMQ-сокеты (`tokenizer`, `scheduler_input`, `rpc`, `metrics`) не аутентифицируются. Хост из `--dist-init-addr` — это интерфейс, на котором они слушают; выносите его в доверенный сегмент, а не на публичный адрес. Это отдельный от `--host`/`--api-key` контур: ограничение HTTP-фасада на управляющий слой не распространяется.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --tensor-parallel-size 4 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.10:50000
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 16 --dp-size 16 --enable-dp-attention --nnodes 2 --node-rank 1 --dist-init-addr 10.0.0.10:50000 --dist-timeout 1800
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/network.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
