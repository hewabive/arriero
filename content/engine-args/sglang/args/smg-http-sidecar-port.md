---
schema: 1
engine: sglang
primaryName: "--smg-http-sidecar-port"
title: "--smg-http-sidecar-port"
summary: Порт вспомогательного HTTP-сервера, который поднимается только в устаревшем режиме SMG gRPC и отдает /metrics, /start_profile и /stop_profile. В обычном HTTP-режиме аргумент полностью инертен.
group: observability
related:
  - --smg-grpc-mode
  - --grpc-mode
  - --grpc-port
  - --port
  - --host
  - --enable-metrics
---

# --smg-http-sidecar-port

## Кратко

В режиме `--smg-grpc-mode` SGLang отдает основной трафик по gRPC через внешний пакет `smg-grpc-servicer`, а всё, что нужно по HTTP, выносит в маленький aiohttp-сервер: `/metrics` (только при `--enable-metrics`), `/start_profile` и `/stop_profile`. Этот аргумент задает порт такого сервера.

Аргумент читается ровно в одном месте — `serve_grpc` (`sglang/python/sglang/srt/entrypoints/grpc_server.py`). В штатном HTTP-режиме запуска функция не вызывается, и значение не значит ничего. Справка формулирует это прямо: «Not used in HTTP mode».

## Оригинальная справка

```text
Port for the HTTP sidecar server in legacy SMG gRPC mode (--smg-grpc-mode). Serves Prometheus metrics and profiling endpoints. Defaults to --port + 1. Not used in HTTP mode.
```

## Паспорт аргумента

- Флаги: `--smg-http-sidecar-port`, алиас `--grpc-http-sidecar-port`
- Группа: `observability`
- Тип значения: int (порт TCP)
- Допустимые значения: `choices` нет; диапазон портов не проверяется — некорректное значение проявится как ошибка привязки сокета
- Значение по умолчанию: `None`
- Эффективное значение: при `None` вычисляется как `--port + 1` в момент запуска gRPC-сервера. `__post_init__` этого не делает, поэтому в дампе `server_args=` значение останется `None` — фактический порт виден только в строке лога
- Где объявлен: `ServerArgs.smg_http_sidecar_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный аргумент устаревшего режима. Сам режим объявлен legacy: `--grpc-mode` помечен как deprecated и транслируется в `--smg-grpc-mode`, а рядом существует нативный gRPC-сервер, включаемый `--grpc-port`
- Этап применения: запуск `serve_grpc`, после инициализации менеджера запросов

## Что меняет в движке

```python
sidecar_port = (
    server_args.smg_http_sidecar_port
    if server_args.smg_http_sidecar_port is not None
    else server_args.port + 1
)
```

Дальше собирается aiohttp-приложение:

- при `--enable-metrics` в него добавляется маршрут `GET /metrics`, собирающий метрики из мультипроцессного реестра `prometheus_client`; попутно выставляется `PROMETHEUS_MULTIPROC_DIR` — это должно произойти **до** порождения scheduler-процессов, потому что переменная наследуется при fork;
- после готовности менеджера запросов добавляются `POST /start_profile` и `POST /stop_profile`;
- сервер поднимается на `--host` и вычисленном порту, в лог уходит `HTTP sidecar server started on http://<host>:<port>`.

Отказ привязки не фатален: `OSError` и любое другое исключение перехватываются, в лог пишется `Failed to start HTTP sidecar server: … Continuing without metrics/profile endpoints.`, и gRPC продолжает обслуживать запросы без метрик и профилирования.

Есть и версионное ограничение: sidecar поднимается из колбэка `on_request_manager_ready`, который принимают только релизы `smg-grpc-servicer` ≥ 0.5.3. На более старом пакете при `--enable-metrics` запуск падает с явным `RuntimeError`, а без него — печатается предупреждение и sidecar просто не появляется.

## Значения и формат

- Явный порт: `--smg-http-sidecar-port 30100`.
- Алиас `--grpc-http-sidecar-port` — то же поле; отдельного файла и отдельного поведения у него нет.
- Не задан — `--port + 1`. Это тихий источник конфликтов: соседний порт может быть занят другим процессом или вторым инстансом.
- Значение действует только вместе с `--smg-grpc-mode` (или устаревшим `--grpc-mode`, который в него транслируется с предупреждением).
- В этом же режиме порт самого gRPC при незаданном `--grpc-port` выводится как `--port + 10000`.

## Когда использовать

- Только в устаревшем SMG gRPC-режиме, и только чтобы развести порт sidecar с чем-то уже занятым.
- Для нового кода этот режим не нужен: обычный HTTP-запуск отдает `/metrics` и профилирование с основного порта, а нативный gRPC (`--grpc-port`) поднимается рядом с HTTP.
- Не пытайтесь использовать аргумент как «второй HTTP-порт» в обычном режиме — там он не читается вовсе.

## Влияние на производительность и память

На VRAM, RAM модели, скорость генерации и время старта не влияет. Один дополнительный слушающий сокет и aiohttp-приложение из двух-трех маршрутов. Единственная измеримая нагрузка — сборка мультипроцессных метрик на каждый запрос `/metrics`.

## Взаимодействие с другими аргументами

- `--smg-grpc-mode` / `--grpc-mode`: единственный режим, в котором аргумент действует; второй флаг устарел и транслируется в первый с предупреждением.
- `--port`: база для значения по умолчанию (`+1`).
- `--grpc-port`: порт самого gRPC; при незаданном значении в legacy-режиме выводится как `--port + 10000`. Валидация `--grpc-port != --port` в legacy-режиме не выполняется, а совпадение sidecar-порта с gRPC-портом не проверяется вообще.
- `--host`: sidecar биндится на тот же интерфейс, что и основной сервер.
- `--enable-metrics`: определяет, появится ли маршрут `/metrics` и будет ли старый пакет считаться недостаточным (`RuntimeError`).

## Типовые проблемы и диагностика

- **Симптом:** `/metrics` недоступен, в логе `Failed to start HTTP sidecar server: [Errno 98] Address already in use`. **Причина:** порт `--port + 1` занят. **Лечение:** задать `--smg-http-sidecar-port` явно.
- **Симптом:** `RuntimeError: --enable-metrics requires smg-grpc-servicer ≥ 0.5.3 …`. **Причина:** установленный пакет не принимает колбэк, из которого поднимается sidecar. **Лечение:** обновить пакет или снять `--enable-metrics`.
- **Симптом:** предупреждение `Installed smg-grpc-servicer does not accept 'on_request_manager_ready'; HTTP sidecar disabled …`. **Причина:** то же, но без `--enable-metrics`. **Лечение:** обновить пакет, если нужны профилировочные эндпоинты.
- **Симптом:** аргумент задан, ничего не изменилось. **Причина:** сервер запущен в обычном HTTP-режиме. **Проверка:** в логе должна быть строка `HTTP sidecar server started on http://…`; если ее нет, sidecar не поднимался.
- **Симптом:** `ImportError` про `smg_grpc_servicer` при старте. **Причина:** режим включен, пакет не установлен. **Лечение:** `pip install smg-grpc-servicer[sglang]` либо отказаться от режима.
- **Проверка принятого значения:** дамп `server_args=` покажет `smg_http_sidecar_port=None` даже когда порт фактически выбран; смотрите строку `HTTP sidecar server started on …`.

## В arriero

Аргумент неприменим. Инстанс kind `ktransformers` в arriero запускается как обычный HTTP-сервер SGLang, менеджер строит базовый URL инстанса из одного HTTP-порта и опрашивает `/health` и `/v1/models` (`apps/api/src/process/engine-probe.ts`), а прокси форвардит трафик на тот же адрес. Режима SMG gRPC в поддерживаемом профиле нет (`docs/KTRANSFORMERS_OPERATIONS.md`, arriero), поэтому sidecar никогда не поднимается, и указание порта — мертвая запись в определении инстанса.

Отдельно стоит помнить о значении по умолчанию `--port + 1`: если бы режим когда-нибудь использовался, этот порт занимался бы без ведома менеджера. arriero учитывает только объявленный HTTP-порт инстанса, поэтому такой «невидимый» сосед приводил бы к конфликтам при запуске двух инстансов подряд.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --smg-grpc-mode --enable-metrics --smg-http-sidecar-port 30100
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics
```

## Источники

- `sglang/python/sglang/srt/entrypoints/grpc_server.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `apps/api/src/process/engine-probe.ts`
