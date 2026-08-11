---
schema: 1
engine: sglang
primaryName: "--otlp-traces-endpoint"
title: "--otlp-traces-endpoint"
summary: Адрес OTLP-коллектора, куда уходят трассы при --enable-trace. Без --enable-trace значение полностью инертно; экспорт по gRPC всегда идет без TLS, а достижимость адреса при старте не проверяется.
group: observability
related:
  - --enable-trace
  - --trace-modules
  - --enable-metrics
  - --disaggregation-mode
  - --dp-size
---

# --otlp-traces-endpoint

## Кратко

Значение передается первым аргументом в `process_tracing_init` (`sglang/python/sglang/srt/observability/trace.py`) — но только если задан `--enable-trace`. Без него ни одна из пяти точек инициализации (tokenizer в `entrypoints/engine.py`, HTTP-слой, scheduler на каждом ранге, DP-контроллер, encode-сервер) не вызывается, и аргумент не значит ничего.

Три вещи, которые надо знать до включения:

1. Без установленного пакета `opentelemetry` `process_tracing_init` бросает `RuntimeError` — то есть `--enable-trace` без зависимостей это не деградация, а отказ старта.
2. Транспорт выбирается **переменной окружения**, а не аргументом: `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, по умолчанию `grpc`.
3. gRPC-экспортер создается как `insecure=True` — трассы уходят открытым текстом, и переключателя TLS в CLI нет.

## Оригинальная справка

```text
Config opentelemetry collector endpoint if --enable-trace is set. format: <ip>:<port>
```

## Паспорт аргумента

- Флаги: `--otlp-traces-endpoint`
- Группа: `observability`
- Тип значения: str
- Допустимые значения: `choices` нет. Форма зависит от транспорта: для `grpc` — `<host>:<port>` без схемы (как в справке), для `http/protobuf` — полный URL, который ожидает `OTLPSpanExporter` HTTP-варианта
- Значение по умолчанию: `localhost:4317` (стандартный gRPC-порт OTLP)
- Эффективное значение: совпадает с заданным; `__post_init__` его не трогает. Действует только при `--enable-trace`
- Где объявлен: `ServerArgs.otlp_traces_endpoint`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация каждого процесса, участвующего в трассировке (tokenizer, HTTP, scheduler, DP-контроллер, encode-сервер)

## Что меняет в движке

`process_tracing_init(otlp_endpoint, server_name, trace_modules)` выполняет:

1. разбор `--trace-modules` в глобальный список разрешенных модулей;
2. проверку, что пакет `opentelemetry` импортировался; иначе — `RuntimeError("opentelemetry package is not installed!!! …")`;
3. создание `Resource` с `SERVICE_NAME`. Имя сервиса во всех точках вызова захардкожено строкой `"sglang"` — задать его из CLI нельзя, различать инстансы в коллекторе придется по другим атрибутам;
4. создание `TracerProvider` с собственным генератором идентификаторов и `BatchSpanProcessor` вокруг экспортера. Параметры батчинга — переменные окружения `SGLANG_OTLP_EXPORTER_SCHEDULE_DELAY_MILLIS` (по умолчанию 500 мс) и `SGLANG_OTLP_EXPORTER_MAX_EXPORT_BATCH_SIZE` (по умолчанию 64);
5. любую ошибку на этом шаге заворачивает в `RuntimeError(f"initialize opentelemetry error:{e}. Please set correct otlp endpoint.")`;
6. при `SGLANG_TRACE_ASYNC=1` дополнительно поднимает асинхронный экспортер (`observability/trace_async.py`) с тем же адресом.

Выбор экспортера — `get_otlp_span_exporter`:

```python
protocol = os.environ.get(OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, "grpc")
```

Поддерживаются только `grpc` и `http/protobuf`; иное значение переменной дает `ValueError` с перечислением допустимых. Для `grpc` создается `GRPCSpanExporter(endpoint=endpoint, insecure=True)`, для `http/protobuf` — `HTTPSpanExporter(endpoint=endpoint)`.

Достижимость адреса при старте **не проверяется**: экспортер только конструируется, соединение устанавливается лениво в фоновом потоке `BatchSpanProcessor`. Недоступный коллектор не мешает серверу обслуживать запросы; ошибки экспорта пишет уже сам opentelemetry через свои логгеры.

## Значения и формат

- `localhost:4317` (по умолчанию) — предполагает коллектор на том же хосте, gRPC.
- `10.0.0.5:4317` — удаленный коллектор. Учтите `insecure=True`: трафик не шифруется, ограничивайте его сетью.
- Для HTTP-транспорта потребуется полный URL, а не `<ip>:<port>`; форма из справки описывает только gRPC-случай.
- Схема `http://`/`https://` в значении при gRPC-транспорте не нужна.
- Уровень детализации трасс задается переменной окружения `SGLANG_TRACE_LEVEL` (по умолчанию 3) и меняется на живом сервере через `GET|POST /set_trace_level?level=N`; при уровне 0 спаны не создаются.

## Когда использовать

- Есть развернутый OTLP-коллектор и нужна сквозная картина «HTTP → tokenizer → scheduler → forward» по одному запросу, особенно в PD-disaggregation, где стадии живут в разных процессах.
- Клиент присылает `traceparent`/`tracestate` — SGLang их подхватывает (`TRACE_HEADERS` в `observability/trace.py`) и продолжает внешнюю трассу; тогда трассировка окупается сразу.
- Не трогайте аргумент, если `--enable-trace` не задан: значение по умолчанию само по себе никуда не ходит и порт 4317 не занимает.
- Для одиночного локального сервера трассировка обычно избыточна — метрики (`--enable-metrics`) и трассы запросов прокси arriero отвечают на те же вопросы дешевле.

## Влияние на производительность и память

- Сам адрес ничего не стоит. Стоимость создает `--enable-trace`: спаны на каждый запрос, фоновый поток экспорта, буфер батчей.
- RAM: буфер `BatchSpanProcessor` в каждом процессе, участвующем в трассировке (а их при TP > 1 несколько).
- Сеть: постоянный исходящий поток на коллектор с периодом `SGLANG_OTLP_EXPORTER_SCHEDULE_DELAY_MILLIS`.
- На VRAM не влияет. При недоступном коллекторе экспорт копит и отбрасывает батчи в фоне — генерация не блокируется.

## Взаимодействие с другими аргументами

- `--enable-trace`: единственное условие, при котором адрес вообще читается.
- `--trace-modules`: разбирается в том же вызове `process_tracing_init` и фильтрует, какие подсистемы порождают спаны.
- `--disaggregation-mode`: определяет метку потока (`Prefill Scheduler`, `Decode Tokenizer` и т. д.), с которой спаны попадут в коллектор.
- `--dp-size` / `--tp-size`: каждый scheduler-ранг инициализирует трассировку отдельно, и все они пишут в один и тот же адрес.
- `--enable-metrics`: независимый канал; трассы и метрики не заменяют друг друга.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: opentelemetry package is not installed!!!` при старте. **Причина:** задан `--enable-trace` без зависимостей. **Лечение:** установить пакеты opentelemetry SDK и OTLP-экспортера либо снять `--enable-trace`.
- **Симптом:** `RuntimeError: initialize opentelemetry error: … Please set correct otlp endpoint.` **Причина:** экспортер не сконструировался — обычно синтаксически неверный адрес или несовместимая версия SDK. **Лечение:** привести адрес к форме, которую ждет выбранный транспорт.
- **Симптом:** `ValueError: Unsupported OTLP protocol …`. **Причина:** в `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` значение, отличное от `grpc` и `http/protobuf`.
- **Симптом:** сервер работает, трасс в коллекторе нет. **Причины:** коллектор недоступен (проверяется только по логам opentelemetry, не по логам SGLang); либо `SGLANG_TRACE_LEVEL=0`; либо нужный модуль отфильтрован `--trace-modules`.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `enable_trace=` и `otlp_traces_endpoint=`.

## В arriero

Трассировка движка — независимый от менеджера канал: arriero не поднимает коллектор, не проксирует OTLP и в разборе лога инстанса трассы не участвуют.

Учитывайте два момента. Первое: строки об ошибках экспорта, которые пишет opentelemetry при недоступном коллекторе, попадают в общий stdout процесса, а значит — в лог инстанса. Разбор лога (`apps/api/src/process/log-parsers/sglang.ts`) считает ошибкой любую строку со словом `error` или `failed`, и здоровый инстанс уйдет в `degraded` (`apps/api/src/process/health-summary.ts`) просто из-за недоступного коллектора. Не оставляйте `--enable-trace` с адресом «на будущее».

Второе: если задача — понять, где именно ушло время у конкретного запроса, у arriero есть собственная история трасс прокси с фильтрами и фасетами (`#/proxy/traces`, `docs/API_PROXY_FOUNDATION.md`, arriero), которая покрывает путь от клиента до движка и не требует ни коллектора, ни дополнительных зависимостей в окружении.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-trace --otlp-traces-endpoint 127.0.0.1:4317
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-trace --otlp-traces-endpoint 10.0.0.5:4317 --trace-modules request
```

## Источники

- `sglang/python/sglang/srt/observability/trace.py`
- `sglang/python/sglang/srt/observability/trace_async.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/process/log-parsers/sglang.ts`, `apps/api/src/process/health-summary.ts`
