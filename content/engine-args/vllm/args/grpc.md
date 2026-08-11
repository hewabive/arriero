---
schema: 1
engine: vllm
primaryName: "--grpc"
title: "--grpc"
summary: Заменяет весь HTTP-фронтенд на gRPC-сервер из стороннего пакета `smg-grpc-servicer`. Короткое замыкание в самом начале `serve`: OpenAI-совместимых endpoint'ов, `/metrics` и большинства аргументов фронтенда в этом режиме просто нет.
group: null
related:
  - --host
  - --port
  - --api-server-count
  - --headless
  - --ssl-keyfile
  - --shutdown-timeout
  - --disable-log-stats
  - --enable-log-requests
---

# --grpc

## Кратко

`--grpc` — не переключатель протокола поверх общей обвязки, а отдельная ветка запуска. `ServeSubcommand.cmd` проверяет флаг **первым делом** и, если он задан, уходит в `serve_grpc(args)` и возвращается: ни разрешение `--api-server-count`, ни проверки headless, ни выбор режима балансировки data parallelism не выполняются вообще.

В этом режиме поднимается один процесс с `AsyncLLM` и gRPC-сервером, реализованным во внешнем пакете `smg-grpc-servicer` (extra `vllm[grpc]`, в `setup.py` — `smg-grpc-servicer[vllm] >= 0.5.2`). Реализация сервиса живет вне репозитория vLLM, поэтому контракт RPC определяется версией этого пакета, а не версией движка.

## Оригинальная справка

```text
Launch a gRPC server instead of the HTTP OpenAI-compatible server. Requires: pip install vllm[grpc].
```

## Паспорт аргумента

- Флаги: `--grpc`
- Группа argparse: без группы (объявлен напрямую в `make_arg_parser`)
- Тип значения: bool, `action="store_true"` — только включение, парной `--no-grpc` нет
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:make_arg_parser`
- Этап применения: первая же ветка в `ServeSubcommand.cmd`, до разрешения топологии процессов и до `create_engine_config`

## Что меняет в движке

`serve_grpc` (`vllm/entrypoints/grpc_server.py`) делает следующее:

1. импортирует `grpc`, `grpc_health`, `grpc_reflection` и `smg_grpc_proto`/`smg_grpc_servicer`; при неудаче поднимает `ImportError` с текстом `gRPC mode requires smg-grpc-servicer. If not installed, run: pip install vllm[grpc]. ...`;
2. собирает `VllmConfig` обычным `AsyncEngineArgs.create_engine_config()` — весь слой аргументов движка (память, планировщик, параллелизм) работает как всегда;
3. создает `AsyncLLM.from_vllm_config(...)`, передавая туда только `enable_log_requests` и `disable_log_stats` из аргументов фронтенда;
4. поднимает `grpc.aio.server` с неограниченным размером сообщений (`grpc.max_send_message_length` и `max_receive_message_length` равны `-1`) и послаблением по keepalive-пингам (`grpc.http2.min_recv_ping_interval_without_data_ms` = 10000);
5. регистрирует `VllmEngineServicer`, стандартный `grpc.health.v1.Health` и server reflection;
6. биндит `f"{args.host or '0.0.0.0'}:{args.port}"` через `add_insecure_port` и запускает сервер;
7. при `--disable-log-stats` не заданном — заводит собственную фоновую задачу, вызывающую `async_llm.do_log_stats()` каждые `VLLM_LOG_STATS_INTERVAL` секунд (это ручная копия того, что в HTTP-режиме делает `lifespan`).

Чего в этом режиме нет:

- **FastAPI-приложения целиком.** Нет `/v1/chat/completions`, `/v1/models`, `/health`, `/metrics`. Метрики Prometheus не экспонируются никак — остается только периодическая строка в логе.
- **TLS.** Порт открывается через `add_insecure_port`; `--ssl-keyfile`, `--ssl-certfile` и родственные аргументы фронтенда не читаются.
- **Аутентификации по `--api-key`**, шаблонов чата, парсеров tool-call и reasoning — всё это части HTTP-слоя.
- **Масштабирования фронтенда.** `--api-server-count` и `--headless` в эту ветку не доходят.
- **Учета `--shutdown-timeout`.** Остановка идет по своему пути: `server.stop(grace=5.0)`, затем `async_llm.shutdown()` **без** аргумента `timeout`, из-за чего менеджер процессов применяет запасные 5 секунд вместо настроенного значения.

Тот же файл содержит собственный `main()` для запуска через `python -m vllm.entrypoints.grpc_server`, и там дефолты другие: `--host 0.0.0.0` и `--port 50051`. Через `vllm serve --grpc` действуют дефолты `FrontendArgs`: `host = None` (что в `serve_grpc` превращается в `0.0.0.0`) и `port = 8000`.

## Значения и формат

- Флаг без значения. Форма `--grpc=true` не поддерживается, парной `--no-grpc` нет.
- Из YAML через `--config` включается ключом `grpc: true`; `false` молча отбрасывается.
- Порт берется из `--port` (по умолчанию 8000), адрес — из `--host`; пустой `--host` означает все интерфейсы.

## Когда использовать

- Есть внешний потребитель, говорящий на протоколе `smg-grpc-servicer`, и HTTP-совместимость не нужна.
- Нужны server reflection и стандартный gRPC health-check для Kubernetes-проб вместо HTTP `/health`.
- **Не используйте в инстансах arriero.** Управляемый профиль vLLM построен на OpenAI-совместимом HTTP: `docs/VLLM_OPERATIONS.md` (arriero) фиксирует «Public API — arriero OpenAI surface and Anthropic bridge», проверка готовности идет через HTTP health и обнаружение модели, а прокси-таргеты обращаются к endpoint'ам `/v1/*`. С `--grpc` инстанс не пройдет health, не появится в обнаружении моделей и не сможет обслуживать прокси.
- Не используйте на сервере, доступном за пределами доверенной сети: TLS в этом режиме недоступен, а аутентификации фронтенда нет.

## Влияние на производительность и память

- **VRAM.** Не влияет: движок конфигурируется теми же аргументами.
- **RAM и CPU.** Немного меньше, чем у HTTP-режима: нет FastAPI, uvicorn и инструментатора Prometheus.
- **Ограничения сообщений.** Сняты (`-1`), поэтому крупные промпты и ответы не режутся транспортом; обратная сторона — отсутствие защиты от гигантского запроса на уровне gRPC.
- **Keepalive.** Клиентские пинги разрешены раз в 10 секунд без передачи данных — послабление специально для непотоковых запросов, где во время генерации кадры DATA не идут.
- **Наблюдаемость.** Заметно хуже: `/metrics` нет, остается только периодический лог статистики (и тот выключается `--disable-log-stats`).

## Взаимодействие с другими аргументами

- `--host`, `--port`: адрес прослушивания; пустой host означает `0.0.0.0`, дефолтный порт — 8000.
- `--api-server-count`, `--headless`: не действуют — ветка `--grpc` выполняется раньше их обработки.
- `--ssl-keyfile` и прочие TLS-аргументы: игнорируются, порт открывается без шифрования.
- `--shutdown-timeout`: не применяется в этом режиме; остановка использует фиксированный grace 5 секунд у gRPC-сервера и запасные 5 секунд у менеджера процессов.
- `--disable-log-stats`, `--enable-log-requests`: единственные два аргумента фронтенда, которые режим действительно читает.
- Все аргументы движка (`--gpu-memory-utilization`, `--max-model-len`, `--max-num-seqs`, параллелизм и прочие) работают без изменений.

## Типовые проблемы и диагностика

- **Симптом:** `ImportError: gRPC mode requires smg-grpc-servicer. If not installed, run: pip install vllm[grpc].` **Причина:** extra не установлен либо версия пакета не совпадает с версией vLLM. **Лечение:** установить `vllm[grpc]` в то же окружение; в тексте исключения указана цепочка исходной ошибки импорта, по которой видно, что именно не сошлось.
- **Симптом:** `curl http://host:8000/v1/models` отвечает отказом соединения на уровне протокола. **Причина:** порт слушает gRPC, а не HTTP. **Проверка:** `grpcurl -plaintext host:8000 list` — reflection включена и должна показать `VllmEngine` и `grpc.health.v1.Health`.
- **Симптом:** нечего отдать системе мониторинга. **Причина:** `/metrics` в этом режиме не существует. **Лечение:** снимать статистику из лога либо перейти на HTTP-режим.
- **Симптом:** остановка не дожидается активных запросов, хотя `--shutdown-timeout` задан. **Причина:** значение в этой ветке не используется. **Лечение:** учитывать фиксированные 5 секунд.
- **Подтверждение принятого значения:** строки `vLLM gRPC server started on <host>:<port>` и `Server is ready to accept requests` при старте.

## Примеры

```bash
vllm serve /models/Qwen3-4B --grpc --host 127.0.0.1 --port 50051
```

```bash
vllm serve /models/Qwen3-4B --grpc --port 50051 --gpu-memory-utilization 0.85 --max-model-len 8192
```

## Источники

- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/grpc_server.py`
- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/v1/utils.py`
- `vllm/setup.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
