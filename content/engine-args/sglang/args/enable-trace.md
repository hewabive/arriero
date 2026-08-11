---
schema: 1
engine: sglang
primaryName: "--enable-trace"
title: "--enable-trace"
summary: Включает трассировку запросов через OpenTelemetry с экспортом в OTLP-коллектор. Требует установленных пакетов `opentelemetry-*`, иначе процессы падают на старте с явной ошибкой.
group: observability
related:
  - --otlp-traces-endpoint
  - --trace-modules
  - --enable-metrics
  - --enable-request-time-stats-logging
  - --disaggregation-mode
  - --max-running-requests
---

# --enable-trace

## Кратко

Флаг поднимает OpenTelemetry в каждом процессе сервера (HTTP/tokenizer, scheduler, data-parallel-контроллер) и начинает экспортировать спаны в OTLP-коллектор по адресу из `--otlp-traces-endpoint`. Результат — распределенная трасса одного запроса, где видно, сколько он пролежал в очереди, сколько шел prefill, сколько decode, и как это разложено по процессам и рангам. Единственный аргумент этой группы, который **добавляет внешнюю зависимость**: пакеты `opentelemetry-*` в SGLang опциональны (extra `tracing`), и без них `process_tracing_init` бросает `RuntimeError` — сервер не стартует.

## Оригинальная справка

```text
Enable opentelemetry trace
```

## Паспорт аргумента

- Флаги: `--enable-trace`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; парной формы `--no-*` не существует
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает. Фактическая активность трассировки дополнительно зависит от уровня `SGLANG_TRACE_LEVEL` (`0` отключает при включенном флаге) и от `--trace-modules`
- Где объявлен: `ServerArgs.enable_trace`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: запуск процессов — `run_scheduler_process`, lifespan FastAPI, `data_parallel_controller`; далее — на каждом инструментированном участке обработки запроса

## Что меняет в движке

### Инициализация

`process_tracing_init(otlp_endpoint, "sglang", trace_modules=…)` (`sglang/python/sglang/srt/observability/trace.py`) вызывается **в каждом** процессе отдельно:

1. если пакет `opentelemetry` не импортировался, немедленно бросается `RuntimeError("opentelemetry package is not installed!!! Please not enable tracing or install opentelemetry")`;
2. создается `TracerProvider` с ресурсом `service.name = "sglang"` и собственным генератором идентификаторов;
3. вешается `BatchSpanProcessor` с параметрами из переменных окружения `SGLANG_OTLP_EXPORTER_SCHEDULE_DELAY_MILLIS` (по умолчанию 500 мс) и `SGLANG_OTLP_EXPORTER_MAX_EXPORT_BATCH_SIZE` (64);
4. выбирается экспортер по `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` — `grpc` (по умолчанию) или `http/protobuf`; любое другое значение дает `ValueError`;
5. при `SGLANG_TRACE_ASYNC=1` дополнительно поднимается отдельный процесс-экспортер, чтобы убрать создание спанов с горячего пути.

Сразу после инициализации каждый процесс регистрирует имя потока (`trace_set_thread_info`) с указанием роли и рангов TP/PP/DP — в Jaeger это дает отдельную дорожку на процесс.

### Что трассируется

Инструментированы главные потоки tokenizer'а и scheduler'а. Контекст запроса `TraceReqContext` создается на каждый запрос и активен только при `opentelemetry_initialized and trace_level > 0`. Фильтр `--trace-modules` (по умолчанию `request`) отсекает спаны явно поименованных модулей; контексты без имени модуля трассируются всегда.

Заголовки `traceparent` и `tracestate` из входящего HTTP-запроса подхватываются и продолжают внешнюю трассу — то есть трасса клиента и трасса движка сшиваются.

Уровень детализации задается `SGLANG_TRACE_LEVEL` (0 — выключено, 1 — только важные срезы, 2 — все, кроме вложенных, 3 — все; по умолчанию 3) и меняется на лету через `GET /set_trace_level?level=N`. Без `--enable-trace` изменение уровня ничего не включает.

Отдельно флаг читается в mooncake-транспорте PD-дизагрегации (`sglang/python/sglang/srt/disaggregation/mooncake/conn.py`) и добавляет спаны на передачу KV.

## Значения и формат

- Флаг без значения; `--enable-trace true` argparse не примет.
- Требуются пакеты `opentelemetry-api`, `opentelemetry-sdk`, `opentelemetry-exporter-otlp`, `opentelemetry-exporter-otlp-proto-grpc`. В `python/pyproject.toml` checkout'а они объявлены в необязательном extra `tracing`, а не в основных зависимостях. Проверить свою сборку: `<env>/bin/python -c "import opentelemetry.sdk; print('ok')"`.
- Адрес коллектора задается `--otlp-traces-endpoint` в формате `<host>:<port>`, по умолчанию `localhost:4317` (порт gRPC OTLP). Для HTTP-экспортера нужно и выставить `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`, и указать полный URL вида `http://host:4318/v1/traces`.
- Отключить трассировку после старта можно, не перезапуская сервер: `GET /set_trace_level?level=0`. Сами провайдеры при этом останутся поднятыми.

## Когда использовать

- Когда нужен путь **одного** конкретного запроса через все процессы: очередь → prefill → decode → отдача. Ни метрики, ни `--enable-request-time-stats-logging` этого не дают: первые агрегируют, второй печатает только итоговые длительности двух фаз.
- В PD-дизагрегации: трассы — единственный практичный способ увидеть, сколько заняла передача KV между стадиями и где встал bootstrap.
- Когда клиент уже трассируется: продолжение внешней трассы через `traceparent` дает сквозную картину от приложения до forward.
- Не включать «на всякий случай» в продакшене при больших батчах: синхронное создание спанов бьет по throughput, и апстрим прямо рекомендует в этом случае `SGLANG_TRACE_ASYNC=1`.
- Не включать без работающего коллектора: `BatchSpanProcessor` будет копить спаны и периодически валиться на экспорте, засоряя лог.
- Не рассматривать как замену метрикам: у трасс нет ретенции и агрегатов, это инструмент точечной диагностики.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: буфер `BatchSpanProcessor` (до `SGLANG_OTLP_EXPORTER_MAX_EXPORT_BATCH_SIZE` спанов на флаш, очередь провайдера сверху) плюс `TraceReqContext` на каждый активный запрос со стеком срезов и кешем событий.
- Throughput: главный риск. Создание спанов синхронно, внутри горячего цикла scheduler'а, и апстрим-документация прямо указывает на деградацию при больших батчах из-за блокировок в OTel и фоновых потоков экспорта. Смягчается снижением `SGLANG_TRACE_LEVEL` до 1 и переходом на `SGLANG_TRACE_ASYNC=1`.
- Latency: экспорт вынесен в фоновый поток (или процесс при async), поэтому на путь ответа влияет опосредованно — через занятость CPU.
- Время старта: плюс импорт и инициализация OTel в каждом процессе.
- Сеть: постоянный исходящий поток к коллектору, объем пропорционален числу запросов и уровню детализации.

## Взаимодействие с другими аргументами

- `--otlp-traces-endpoint`: адрес коллектора. Значение по умолчанию `localhost:4317` предполагает коллектор на том же хосте.
- `--trace-modules`: список модулей, которым разрешено эмитить спаны (`request`, `mooncake`); по умолчанию `request`.
- `--enable-metrics`: независим. Метрики — агрегаты, трассы — отдельные запросы; включаются раздельно.
- `--enable-request-time-stats-logging`: дешевая альтернатива без внешних зависимостей и без коллектора. Если нужны только `queue_duration` и `forward_duration`, начинайте с него.
- `--disaggregation-mode`: в PD-режиме к меткам потоков добавляются `Prefill`/`Decode`, и трассируется передача KV.
- `--max-running-requests`: чем больше батч, тем заметнее накладные расходы синхронной трассировки.

## Типовые проблемы и диагностика

- `RuntimeError: opentelemetry package is not installed!!!` в scheduler-процессе или в lifespan HTTP-сервера — окружение собрано без extra `tracing`. Ставьте пакеты или снимайте флаг.
- `RuntimeError: initialize opentelemetry error:… Please set correct otlp endpoint.` — коллектор недоступен или адрес задан неверно.
- `ValueError: Unsupported OTLP protocol '…' configured` — в `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` что-то кроме `grpc` и `http/protobuf`.
- Сервер стартовал, но в Jaeger пусто — проверьте `SGLANG_TRACE_LEVEL` (при `0` спаны не создаются) и `--trace-modules`; уровень можно поднять на лету через `GET /set_trace_level?level=3`.
- Throughput просел после включения — снижайте уровень трассировки и включайте `SGLANG_TRACE_ASYNC=1`.
- Спаны есть, но каждый процесс идет отдельной трассой — не совпадает `service.name` или не пробрасывается `traceparent`; в SGLang имя жестко `"sglang"` во всех процессах, так что причина скорее в конфигурации коллектора.
- **В arriero:** окружение для движка ставится провайдером `KTRANSFORMERS_PROVISIONER` (`apps/api/src/envs/provisioners.ts`) как ровно два требования — `kt-kernel==<version>` и `sglang-kt==<version>`, **без extras**. То есть в штатном окружении arriero `opentelemetry` не установлен, и `--enable-trace` уронит инстанс при старте. Окружения неизменяемы (`docs/ENVIRONMENTS.md`), доставить пакет в существующее нельзя — понадобится окружение, собранное иначе. Перед добавлением флага обязательно проверьте импорт вручную.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-trace --otlp-traces-endpoint 127.0.0.1:4317
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-trace --otlp-traces-endpoint 127.0.0.1:4317 --trace-modules request,mooncake
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/trace.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/pyproject.toml`
- `sglang/docs/docs/references/production_request_trace.mdx`
- arriero: `docs/ENVIRONMENTS.md`
