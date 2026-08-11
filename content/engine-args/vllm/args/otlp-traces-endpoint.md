---
schema: 1
engine: vllm
primaryName: "--otlp-traces-endpoint"
title: "--otlp-traces-endpoint"
summary: Адрес OTLP-коллектора, включающий распределённую трассировку: по одному span'у `llm_request` на завершённый запрос плюс span'ы этапов старта. Отсутствие OpenTelemetry в окружении роняет старт с явной ошибкой.
group: ObservabilityConfig
related:
  - --collect-detailed-traces
  - --enable-log-requests
  - --enable-per-request-metrics
  - --disable-log-stats
---

# --otlp-traces-endpoint

## Кратко

Единственный выключатель трассировки: пока он пуст, ни один span не экспортируется, а сопутствующий `--collect-detailed-traces` вообще запрещён валидатором. Задание непустого значения включает три вещи сразу — инициализацию tracer provider в процессе API-сервера, экспорт span'ов этапов старта и per-request span при завершении каждого запроса.

Значение попадает в переменную окружения `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, поэтому дочерние процессы воркеров подхватывают его без отдельного флага.

## Оригинальная справка

```text
Target URL to which OpenTelemetry traces will be sent.
```

## Паспорт аргумента

- Флаги: `--otlp-traces-endpoint`
- Группа argparse: `ObservabilityConfig`
- Тип значения: строка (URL), допускается `None`
- Допустимые значения: не ограничены парсером; формат определяется выбранным протоколом экспортёра — по умолчанию gRPC (`grpc://host:4317`), при `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf` — HTTP-эндпоинт
- Значение по умолчанию: `null` (`None`) — трассировка выключена
- Эффективное значение: не переопределяется, но валидируется на этапе сборки конфига: при недоступности пакетов OpenTelemetry поле отвергается с `ValueError`
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.otlp_traces_endpoint`
- Этап применения: сборка `VllmConfig` (валидация) → инициализация `AsyncLLM` (создание tracer provider) → загрузка модели и компиляция (span'ы этапов) → завершение каждого запроса (span `llm_request`)

## Что меняет в движке

**Валидация.** `_validate_otlp_traces_endpoint` при непустом значении вызывает `is_tracing_available()` и, если пакеты OpenTelemetry не импортируются, поднимает `ValueError: OpenTelemetry is not available. Unable to configure 'otlp_traces_endpoint'. Ensure OpenTelemetry packages are installed.` с приложенным traceback импорта. Отказ происходит до загрузки весов.

**Инициализация.** `AsyncLLM.__init__` вызывает `init_tracer("vllm.llm_engine", endpoint)`. Внутри `init_otel_tracer()` записывает `os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]`, создаёт `Resource` с атрибутами `vllm.instrumenting_module_name` и `vllm.process_id`, вешает `BatchSpanProcessor` и регистрирует `atexit`-шатдаун провайдера. Экспортёр выбирается по `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`: `grpc` (по умолчанию, `insecure=True`) или `http/protobuf`; любое другое значение — `ValueError: Unsupported OTLP protocol '...' is configured`.

Воркеры в многопроцессном исполнителе поднимают собственный tracer через `maybe_init_worker_tracer()`, читая эндпоинт из унаследованной переменной окружения и добавляя атрибуты `vllm.process_kind` и `vllm.process_name`.

**Span'ы этапов старта.** Декоратор `@instrument` расставлен по ключевым точкам: `Initialize model`, `Load model`, `Load weights`, `Download weights - HF`, `Compile graph`, `Inductor compilation`, `Worker init`, `Executor init`, `API server setup`, прогревы CuTeDSL/DeepGEMM. Каждому span'у приписываются атрибуты `code.function`/`code.namespace`/`code.filepath`/`code.lineno`. Без сконфигурированного провайдера эти же вызовы остаются no-op.

**Per-request span.** `OutputProcessor.do_tracing()` вызывается один раз, при завершении запроса, и создаёт span `llm_request` вида `SpanKind.SERVER` с временем начала, равным моменту поступления запроса. Атрибуты: `gen_ai.latency.time_to_first_token`, `gen_ai.latency.e2e`, `gen_ai.latency.time_in_queue`, `gen_ai.latency.time_in_model_prefill`, `gen_ai.latency.time_in_model_decode`, `gen_ai.latency.time_in_model_inference`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `gen_ai.request.id`, а также `top_p`, `max_tokens`, `temperature`, `n`, если они заданы. Текста промпта и ответа в span'е нет.

**Проброс контекста.** `_get_trace_headers()` извлекает из входящего HTTP-запроса заголовки `traceparent`/`tracestate`, только если трассировка включена; иначе при их наличии один раз пишется предупреждение `Received a request with trace context but tracing is disabled`.

## Значения и формат

- URL коллектора. Для Jaeger в стандартной конфигурации — `grpc://<host>:4317`.
- gRPC-экспортёр создаётся с `insecure=True`, то есть TLS для gRPC-транспорта не используется; в upstream-примере это дополняется `OTEL_EXPORTER_OTLP_TRACES_INSECURE=true`.
- Имя сервиса в коллекторе задаётся стандартной переменной `OTEL_SERVICE_NAME`, а не флагом.
- Пустая строка не эквивалентна «выключено»: `is_tracing_enabled()` проверяет `is not None`, поэтому пустое значение включит трассировку и сломает экспортёр.

## Когда использовать

- Нужен разбор latency по фазам (очередь → prefill → decode) с привязкой к внешнему трейсу вызывающего сервиса — это и есть основной сценарий.
- Нужен сквозной trace id между шлюзом и движком: клиент присылает `traceparent`, движок продолжает трейс.
- Не включайте на сервере, доступном не только с localhost, не проверив, куда именно уходят данные: span содержит идентификатор запроса, счётчики токенов и параметры сэмплинга.
- Не включайте ради агрегированных показателей: для них есть `/metrics`, который дешевле.

## Влияние на производительность и память

- **CPU.** На каждый завершённый запрос — сборка словаря атрибутов и создание span'а; экспорт асинхронный, через `BatchSpanProcessor` в фоновом потоке. Порядок величины — доли миллисекунды на запрос, стоимость не зависит от длины ответа.
- **Сеть.** Постоянный поток экспорта в коллектор, батчами.
- **VRAM.** Не влияет.
- **Время старта.** Добавляется инициализация провайдера и создание span'ов этапов; на общем фоне загрузки весов незаметно.
- **Устойчивость.** Недоступный коллектор не блокирует запросы: экспорт идёт в фоне, но SDK будет писать собственные ошибки экспорта в лог.

## Взаимодействие с другими аргументами

- `--collect-detailed-traces`: без этого флага запрещён (`collect_detailed_traces requires --otlp-traces-endpoint to be set.`).
- `--enable-log-requests`, `--enable-per-request-metrics`: альтернативные способы получить per-request данные без внешнего коллектора.
- `--disable-log-stats`: на трассировку не влияет — span'ы строятся в `OutputProcessor`, а не в стат-логгерах.

## Типовые проблемы и диагностика

- **Симптом:** старт падает с `OpenTelemetry is not available. Unable to configure 'otlp_traces_endpoint'.` **Причина:** в окружении нет пакетов OpenTelemetry. **Проверка:** приложенный traceback импорта. **Лечение:** установить их в то же uv-окружение, из которого запускается `vllm serve`.
- **Симптом:** `ValueError: Unsupported OTLP protocol 'http' is configured`. **Причина:** в `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` значение вне пары `grpc` / `http/protobuf`. **Лечение:** исправить переменную.
- **Симптом:** в логе `Received a request with trace context but tracing is disabled`. **Причина:** клиент шлёт `traceparent`, а эндпоинт не задан. **Лечение:** задать эндпоинт либо игнорировать предупреждение (оно печатается один раз).
- **Симптом:** трейсы не появляются в коллекторе, ошибок нет. **Причина:** запросы ещё не завершились (span создаётся только на завершении) либо экспортёр не может достучаться до коллектора. **Проверка:** сообщения экспортёра OTLP в логе процесса. **Лечение:** проверить адрес и протокол.
- **Подтверждение принятого значения:** появление span'ов `llm_request` в коллекторе; в среде исполнения — непустая переменная `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` у процессов воркеров.

## Примеры

```bash
vllm serve /models/Qwen3-4B --otlp-traces-endpoint grpc://127.0.0.1:4317
```

```bash
vllm serve /models/Qwen3-4B --otlp-traces-endpoint grpc://127.0.0.1:4317 --collect-detailed-traces all
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/tracing/__init__.py`
- `vllm/vllm/tracing/otel.py`
- `vllm/vllm/tracing/utils.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/v1/engine/output_processor.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/entrypoints/generate/base/serving.py`
- `vllm/examples/observability/opentelemetry/README.md`
- `vllm/docs/design/metrics.md`
