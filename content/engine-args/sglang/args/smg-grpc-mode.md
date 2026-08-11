---
schema: 1
engine: sglang
primaryName: "--smg-grpc-mode"
title: "--smg-grpc-mode"
summary: Отдельный режим обслуживания: вместо HTTP-сервера поднимается legacy SMG gRPC-сервер из внешнего пакета `smg-grpc-servicer`, а рядом — вспомогательный HTTP-сайдкар с `/metrics` и профилировкой. OpenAI-эндпоинтов и `/health` в этом режиме нет.
group: serving
related:
  - --grpc-mode
  - --grpc-port
  - --smg-http-sidecar-port
  - --sidecar
  - --port
  - --enable-metrics
  - --encoder-only
---

# --smg-grpc-mode

## Кратко

Это не «дополнительный протокол», а **другая точка входа**. `launch_server` смотрит на флаг до всего остального и вместо `sglang.srt.entrypoints.http_server.launch_server` вызывает `serve_grpc`, который делегирует обслуживание пакету `smg-grpc-servicer`. FastAPI/uvicorn при этом не поднимаются вообще: ни `/v1/chat/completions`, ни `/generate`, ни `/health`.

Отличайте от нативного gRPC: тот включается аргументом `--grpc-port` и работает **рядом** с HTTP, а не вместо него.

## Оригинальная справка

```text
Use the legacy SMG gRPC server (smg-grpc-servicer) instead of the HTTP server. Replaces the deprecated --grpc-mode.
```

## Паспорт аргумента

- Флаги: `--smg-grpc-mode`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` выставляет его в `True`, если задан устаревший `--grpc-mode`. Кроме того, при активном legacy-режиме и незаданном `--grpc-port` порт выводится как `--port + 10000`
- Где объявлен: `ServerArgs.smg_grpc_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный (заменяет устаревший `--grpc-mode`)
- Этап применения: `__post_init__` (вывод портов, проверки совместимости) → выбор точки входа в `run_server` до запуска любых процессов

## Что меняет в движке

### Выбор точки входа

`sglang/python/sglang/launch_server.py`:

```python
if server_args.encoder_only:
    if server_args.smg_grpc_mode or server_args.grpc_mode:
        asyncio.run(serve_grpc_encoder(server_args))     # encoder disaggregation
    else:
        launch_server(server_args)                        # encode_server
elif server_args.smg_grpc_mode:
    from sglang.srt.entrypoints.grpc_server import serve_grpc
    asyncio.run(serve_grpc(server_args))
elif server_args.use_ray:
    ...
else:
    from sglang.srt.entrypoints.http_server import launch_server
    launch_server(server_args)
```

### Что поднимается

`serve_grpc` (`sglang/python/sglang/srt/entrypoints/grpc_server.py`) — тонкая обертка:

```python
try:
    from smg_grpc_servicer.sglang.server import serve_grpc as _serve_grpc
except ImportError as e:
    raise ImportError(
        "gRPC mode requires the smg-grpc-servicer package. "
        "If not installed, run: pip install smg-grpc-servicer[sglang]. ..."
    ) from e
```

То есть сам сервер живет во **внешнем пакете**, которого может не быть в закрепленном окружении. Рядом обертка поднимает aiohttp-сайдкар на `--smg-http-sidecar-port` (по умолчанию `--port + 1`) с маршрутами:

- `/metrics` в формате Prometheus — только при `--enable-metrics` (перед запуском планировщиков выставляется `PROMETHEUS_MULTIPROC_DIR`, потому что переменная наследуется при fork'е);
- `/start_profile` и `/stop_profile` — всегда, независимо от `--enable-metrics`.

Сайдкар стартует после готовности request manager'а.

### Порты

```python
legacy_grpc = self.smg_grpc_mode or self.grpc_mode
if legacy_grpc and self.grpc_port is None:
    self.grpc_port = self.port + 10000
...
native_grpc = self.grpc_port is not None and not legacy_grpc
```

`--port` в этом режиме не слушается — он остается базой для производных портов (`+1` сайдкар, `+10000` gRPC). Проверка `--grpc-port != --port` для legacy-режима отключена (условие `not (self.smg_grpc_mode or self.grpc_mode)`).

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — обычный HTTP-режим (или Ray, если задан `--use-ray`).
- Парного `--no-*` нет.
- Совместно с `--encoder-only` даёт третий вариант — gRPC-сервер энкодера для encoder disaggregation.

## Когда использовать

- Инстанс включается в инфраструктуру SGLang Model Gateway, где транспорт — SMG gRPC. Это единственный настоящий сценарий.
- **Не используйте** для «более быстрого протокола» в обычном обслуживании: OpenAI-клиенты сюда не подключатся, а нативный gRPC — это другой флаг.
- **Не используйте**, если что-либо в вашей эксплуатации опирается на HTTP-эндпоинты: мониторинг по `/health`, `/get_server_info`, ручные проверки `/v1/models`.

## Влияние на производительность и память

- На VRAM, KV-пул и скорость forward не влияет: планировщик и модель те же.
- RAM хоста: не поднимаются FastAPI/uvicorn, зато поднимаются aiohttp-сайдкар и gRPC-сервер внешнего пакета — суммарно сопоставимо.
- Сетевой слой другой, поэтому сравнивать latency HTTP и SMG gRPC имеет смысл только измерением на своей нагрузке.

## Взаимодействие с другими аргументами

- `--grpc-mode`: устаревший псевдоним, выставляет этот флаг с предупреждением.
- `--grpc-port`: в legacy-режиме означает порт SMG-сервера (по умолчанию `--port + 10000`), а нативный gRPC-сервер **не** запускается — legacy имеет приоритет.
- `--smg-http-sidecar-port` (алиас `--grpc-http-sidecar-port`): порт вспомогательного HTTP-сервера, по умолчанию `--port + 1`. В HTTP-режиме не используется.
- `--sidecar`: несовместим — `ValueError: --sidecar requires SGLang's native gRPC server; it cannot be combined with --smg-grpc-mode/--grpc-mode.`
- `--enable-metrics`: без него у сайдкара не будет `/metrics`, а профилировочные маршруты останутся.
- `--encoder-only`: меняет точку входа на gRPC-сервер энкодера.
- `--use-ray`: проверяется позже по цепочке `elif`, поэтому legacy gRPC выигрывает.

В arriero инстансы kind `ktransformers` пробуются HTTP-пробой `openai-http` по `/health` и `/v1/models`, а прокси форвардит OpenAI-запросы на тот же порт (`docs/ENGINE_ADAPTERS.md`, `docs/API_PROXY_FOUNDATION.md`). В этом режиме таких эндпоинтов нет, поэтому инстанс никогда не станет healthy и не будет обслуживаемым прокси-таргетом. Практически флаг несовместим с моделью эксплуатации arriero.

## Типовые проблемы и диагностика

- `ImportError: gRPC mode requires the smg-grpc-servicer package. If not installed, run: pip install smg-grpc-servicer[sglang].` — пакета нет в окружении либо версия разошлась (в тексте ошибки прямо сказано смотреть на цепочку исключений).
- **HTTP-порт не отвечает** — так и задумано; проверяйте gRPC-порт (`--port + 10000` по умолчанию) и сайдкар (`--port + 1`).
- **`/metrics` пуст или отсутствует** — не задан `--enable-metrics`; при ошибке настройки метрик в логе будет `Failed to set up metrics: … Continuing without metrics.`
- **Конфликт портов** — в legacy-режиме проверка `--grpc-port != --port` не выполняется; следите за производными портами сами.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --smg-grpc-mode --port 30000 --enable-metrics
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --smg-grpc-mode --grpc-port 50051 --smg-http-sidecar-port 30001 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/launch_server.py`
- `sglang/python/sglang/srt/entrypoints/grpc_server.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- arriero: `docs/ENGINE_ADAPTERS.md`, `docs/API_PROXY_FOUNDATION.md`
