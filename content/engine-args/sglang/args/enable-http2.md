---
schema: 1
engine: sglang
primaryName: "--enable-http2"
title: "--enable-http2"
summary: Заменяет uvicorn на Granian и включает автоопределение HTTP/1.1 и HTTP/2 (в том числе h2c). Требует отдельной установки granian, отключает hot-reload сертификатов и лишает лог строки Uvicorn running on, по которой arriero определяет старт.
group: serving
related:
  - --host
  - --port
  - --tokenizer-worker-num
  - --enable-ssl-refresh
  - --ssl-certfile
  - --ssl-keyfile
  - --ssl-ca-certs
  - --fastapi-root-path
  - --log-level-http
---

# --enable-http2

## Кратко

`--enable-http2` подменяет ASGI-сервер: вместо uvicorn то же приложение обслуживает Granian в режиме `HTTPModes.auto`, то есть согласует HTTP/1.1 или HTTP/2 по факту, включая cleartext-вариант h2c. Само FastAPI-приложение, маршруты и auth-middleware при этом не меняются.

Цена перехода — три вещи: пакет `granian` нужно поставить отдельно (`pip install "sglang[http2]"`), `--enable-ssl-refresh` становится запрещенным, а `--fastapi-root-path` перестает применяться, потому что в вызов Granian он не передается.

## Оригинальная справка

```text
Use Granian instead of Uvicorn as the ASGI server, enabling HTTP/1.1 and HTTP/2 auto-negotiation. Clients may use h2c (cleartext HTTP/2) or plain HTTP/1.1. Requires 'pip install sglang[http2]'.
```

## Паспорт аргумента

- Флаги: `--enable-http2`
- Группа: `serving`
- Тип значения: bool; поле объявлено как `bool`, поэтому argparse получает `action="store_true"` без парного `--no-*`
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False` — работает uvicorn
- Эффективное значение: совпадает с заданным; переписывания нет. Но проверка доступности выполняется рано: `_handle_ssl_validation` в `__post_init__` пробует `import granian` и падает, если пакета нет
- Где объявлен: `ServerArgs.enable_http2`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверка импорта и конфликта с hot-reload) → HTTP-слой, выбор ветки запуска в `_setup_and_run_http_server`

## Что меняет в движке

Никакого влияния на планировщик, память и модель — меняется только транспорт.

`_run_granian_server` (`entrypoints/http_server.py`) собирает сервер по такой схеме:

- при `--tokenizer-worker-num 1` используется `granian.server.embed.Server` (embedded-режим) с `target=app` — живой объект приложения, уже инициализированное глобальное состояние, обычный single-tokenizer lifespan, без shared memory и повторной инициализации воркеров; цикл событий — uvloop;
- при `--tokenizer-worker-num > 1` используется обычный `granian.Granian` с `target="sglang.srt.entrypoints.http_server:app"`, `workers=<N>` и `loop=Loops.uvloop`;
- параметры TLS передаются как `ssl_cert`, `ssl_key`, `ssl_key_password`, `ssl_ca`, а `ssl_client_verify` жестко равен `False` с комментарием «MTls is not supported»;
- `backlog=2048` и `backpressure=2048` выставлены «ровно как дефолты uvicorn»;
- в embedded-режиме Granian не ставит собственных обработчиков сигналов, поэтому SGLang сам вешает `server.stop` на `SIGINT` и `SIGTERM`.

Перед запуском печатается `Starting embedded Granian HTTP/2 server on <host>:<port>` — и это единственная строка, по которой видно, что путь выбран.

Чего в этой ветке **нет**: параметра `root_path`. В uvicorn-ветках `--fastapi-root-path` передается, в Granian-ветке — нет.

## Значения и формат

- Флаг без значения.
- Требуется пакет `granian` (в `python/pyproject.toml` он объявлен как `granian>=2.6.0` в extra-группе). Отсутствие пакета — не предупреждение, а `ValueError` на этапе разбора аргументов.
- h2c (HTTP/2 без TLS) работает благодаря `HTTPModes.auto`: клиент может открыть и обычный HTTP/1.1, и h2c на том же порту. Отдельного «только HTTP/2» режима SGLang не выставляет.
- Взаимная TLS-аутентификация недоступна принципиально: `ssl_client_verify=False` захардкожен.

## Когда использовать

- Много параллельных потоковых соединений от одного клиента: мультиплексирование HTTP/2 избавляет от пула TCP-соединений и от head-of-line blocking на уровне соединений.
- Клиент/шлюз, который умеет только HTTP/2 (некоторые gRPC-совместимые прослойки и service mesh).
- Не включайте ради «просто быстрее»: для одного-двух потоков генерации разницы не будет, а вы потеряете hot-reload сертификатов, поддержку `--fastapi-root-path` и привычные строки лога.
- Не включайте в связке с arriero (см. ниже) — выигрыша нет, а диагностика ухудшается.

## Влияние на производительность и память

- VRAM и модель не затрагиваются.
- RAM: в embedded-режиме (`--tokenizer-worker-num 1`) дополнительных процессов не появляется; при `workers > 1` Granian, как и uvicorn, поднимает N процессов приложения.
- Latency: выигрыш возможен только там, где узкое место — количество TCP-соединений и очередь на них, то есть при десятках параллельных стримов. На время генерации токена транспорт не влияет.
- Время старта: плюс импорт `granian`.

## Взаимодействие с другими аргументами

- `--enable-ssl-refresh`: запрещено. `ValueError: --enable-ssl-refresh is not supported with --enable-http2. Granian does not support SSL certificate hot-reloading.`
- `--fastapi-root-path`: **игнорируется** — в `_run_granian_server` параметр `root_path` не передается.
- `--ssl-certfile` / `--ssl-keyfile` / `--ssl-ca-certs` / `--ssl-keyfile-password`: передаются под именами `ssl_cert`, `ssl_key`, `ssl_ca`, `ssl_key_password`; mTLS выключен.
- `--tokenizer-worker-num`: определяет выбор между embedded-сервером и многопроцессным Granian.
- `--host`, `--port`: те же значения уходят в `address` и `port`.
- `--log-level-http`: передается как `log_level` Granian так же, как и в uvicorn-ветке.
- `--api-key` / `--admin-api-key`: middleware живет на уровне ASGI-приложения, поэтому работает и здесь.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --enable-http2 requires the 'granian' package. Install it with: pip install "sglang[http2]"`. **Причина:** пакета нет в окружении. **Проверка:** `<env>/bin/python -c "import granian; print(granian.__version__)"`.
- **Симптом:** `ValueError: --enable-ssl-refresh is not supported with --enable-http2.` **Лечение:** отказаться от одного из двух.
- **Симптом:** сервер за обратным прокси с префиксом пути отвечает 404. **Причина:** `--fastapi-root-path` в Granian-ветке не применяется. **Лечение:** снять `--enable-http2` либо настроить прокси так, чтобы он снимал префикс сам.
- **Симптом:** в логе нет `Uvicorn running on http://…`. **Причина:** это не дефект — при `--enable-http2` uvicorn не используется; ориентируйтесь на строку `Starting embedded Granian HTTP/2 server on <host>:<port>`.
- **Симптом:** клиент с mTLS получает отказ. **Причина:** `ssl_client_verify=False` захардкожен. **Лечение:** терминировать mTLS на обратном прокси.

## В arriero

Два конкретных последствия, оба проверяемые.

1. **Определение готовности по логу ломается.** Парсер логов SGLang в менеджере (`apps/api/src/process/log-parsers/sglang.ts`) считает процесс стартовавшим по регулярному выражению `Uvicorn running on|Application startup complete` и вытаскивает адрес прослушивания из `Uvicorn running on <url>`. С Granian первой строки не будет, `listeningUrl` останется `null`, а прогресс загрузки застрянет на промежуточной стадии. Итоговый статус инстанса при этом не пострадает — он выводится из HTTP-пробы `/health` (`apps/api/src/process/health-summary.ts`), — но панель загрузки и «адрес прослушивания» станут бесполезны.
2. **Выигрыша нет.** Прокси менеджера ходит в инстанс через `fetch` (undici), то есть по HTTP/1.1; переговоры об HTTP/2 просто не состоятся. Внешние клиенты подключаются к менеджеру, а не к движку напрямую.

Вывод: для kind `ktransformers` `--enable-http2` избыточен и ухудшает наблюдаемость. Оставляйте дефолтный uvicorn.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-http2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --enable-http2 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey.pem
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/pyproject.toml`
- arriero: `apps/api/src/process/log-parsers/sglang.ts`, `docs/KTRANSFORMERS_OPERATIONS.md`
