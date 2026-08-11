---
schema: 1
engine: sglang
primaryName: "--engine-info-bootstrap-port"
title: "--engine-info-bootstrap-port"
summary: Порт вспомогательного HTTP-сервера, через который rank'и регистрируют информацию transfer engine. Поднимается только при `--remote-instance-weight-loader-start-seed-via-transfer-engine` и только на node_rank 0.
group: model
related:
  - --remote-instance-weight-loader-start-seed-via-transfer-engine
  - --remote-instance-weight-loader-backend
  - --load-format
  - --host
  - --node-rank
  - --modelexpress-config
---

# --engine-info-bootstrap-port

## Кратко

Аргумент задает порт для `EngineInfoBootstrapServer` — маленького FastAPI-сервера в daemon-потоке, куда каждый `ModelRunner` регистрирует свои transfer-engine метаданные, а другие инстансы забирают их по HTTP. Он поднимается **только** если задан `--remote-instance-weight-loader-start-seed-via-transfer-engine` и текущий узел имеет `node_rank == 0`. Во всех остальных конфигурациях аргумент полностью инертен, но занятый порт при включенном режиме — это отказ старта.

## Оригинальная справка

```text
Port for the engine info bootstrap server. Default is 6789. Must be set explicitly when running multiple instances on the same node.
```

## Паспорт аргумента

- Флаги: `--engine-info-bootstrap-port`
- Группа: `model`
- Тип значения: целое (номер порта)
- Допустимые значения: любой свободный TCP-порт; проверка занятости выполняется на старте
- Значение по умолчанию: `6789`
- Эффективное значение: не переопределяется; используется как есть
- Где объявлен: `ServerArgs.engine_info_bootstrap_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, применим только к сценарию раздачи весов через transfer engine
- Этап применения: `_launch_subprocesses` в `entrypoints/engine.py`, до запуска планировщиков

## Что меняет в движке

`sglang/python/sglang/srt/entrypoints/engine.py`:

```python
engine_info_bootstrap_server = None
if (server_args.remote_instance_weight_loader_start_seed_via_transfer_engine
        and server_args.node_rank == 0):
    bootstrap_port = server_args.engine_info_bootstrap_port
    if not is_port_available(bootstrap_port):
        raise RuntimeError(
            f"engine_info_bootstrap_port {bootstrap_port} is already in use. "
            f"When running multiple instances on the same node, each instance must use a "
            f"different --engine-info-bootstrap-port."
        )
    engine_info_bootstrap_server = EngineInfoBootstrapServer(host=server_args.host, port=bootstrap_port)
```

Сервер (`entrypoints/engine_info_bootstrap_server.py`) поднимает uvicorn в daemon-потоке с тремя маршрутами: `GET /health`, `PUT /register_transfer_engine_info` (rank регистрирует `session_id` и `weights_info_dict`) и `GET /get_transfer_engine_info?rank=N`. Данные лежат в памяти под обычным `threading.Lock`.

Клиентская сторона — `model_runner_components/remote_instance_weight_transporter.py`: воркер собирает адрес из `server_args.engine_info_bootstrap_url` (это `url(port=engine_info_bootstrap_port)`, то есть тот же `--host`) и делает HTTP PUT.

Два практических следствия:

- сервер слушает на `--host`. Если это `0.0.0.0`, порт открыт наружу так же, как основной API, и **никакой аутентификации у него нет**;
- на одном хосте два инстанса в этом режиме обязаны иметь разные порты — сообщение об ошибке говорит об этом прямым текстом.

## Значения и формат

- Целое число; argparse не проверяет диапазон, проверку занятости делает `is_port_available` уже при старте.
- Значение по умолчанию `6789` — общее для всех инстансов, поэтому конфликт при двух серверах на хосте гарантирован.
- Порт используется и как «слушать» (на seed-узле), и как «куда идти» (в URL воркеров) — одно значение на обе роли.
- В сценариях без transfer engine значение ни на что не влияет и порт не занимается.

## Когда использовать

- Только когда включен `--remote-instance-weight-loader-start-seed-via-transfer-engine`, то есть данный сервер выступает источником весов для других инстансов.
- Обязательно задавайте явно, если на одном узле запускается больше одного такого seed-сервера.
- Меняйте, если 6789 занят чем-то другим на хосте.
- В любых обычных развертываниях (в том числе в arriero, где инстанс поднимается локально и веса читает с диска) аргумент не нужен.

## Влияние на производительность и память

Один поток uvicorn и словарь в памяти — влияние на память и CPU пренебрежимо. На время старта, VRAM, throughput и latency инференса не влияет. Реальный эффект один: при занятом порте старт падает.

## Взаимодействие с другими аргументами

- `--remote-instance-weight-loader-start-seed-via-transfer-engine`: единственный переключатель, который вообще поднимает этот сервер.
- `--node-rank`: сервер поднимается только на нулевом узле.
- `--host`: определяет интерфейс, на котором слушает bootstrap-сервер. Отдельной ручки у него нет.
- `--remote-instance-weight-loader-backend`, `--modelexpress-config`: определяют, каким транспортом реально передаются веса; bootstrap-сервер — только обмен метаданными.
- `--load-format remote_instance`: сторона-потребитель весов.

## Типовые проблемы и диагностика

- `RuntimeError: engine_info_bootstrap_port 6789 is already in use. When running multiple instances on the same node, each instance must use a different --engine-info-bootstrap-port.` — самый частый случай: два seed-сервера с дефолтным портом.
- `404 No transfer engine info for rank N` у потребителя — соответствующий rank еще не зарегистрировался; проверьте, что seed-сервер поднялся (строка «EngineInfoBootstrapServer started on host:port»).
- Порт открыт наружу — следствие `--host 0.0.0.0`; на сервере, доступном не только с localhost, ограничивайте доступ файрволом: у этого endpoint'а нет ни ключей, ни ролей.
- Значение, как его принял движок, — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --remote-instance-weight-loader-start-seed-via-transfer-engine --engine-info-bootstrap-port 6790 --host 127.0.0.1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format remote_instance --remote-instance-weight-loader-backend transfer_engine --engine-info-bootstrap-port 6790
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/engine_info_bootstrap_server.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/remote_instance_weight_transporter.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
