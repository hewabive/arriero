---
schema: 1
engine: sglang
primaryName: "--otlp-service-name"
title: "--otlp-service-name"
summary: Значение `service.name` в OTLP-трассах при `--enable-trace`. Без флага берется переменная `OTEL_SERVICE_NAME`, затем `sglang`; задают, чтобы различать несколько инстансов в одном коллекторе.
group: observability
related:
  - --enable-trace
  - --otlp-traces-endpoint
  - --trace-modules
  - --disaggregation-mode
---

# --otlp-service-name

## Кратко

Имя сервиса, под которым спаны SGLang попадают в OTLP-коллектор (атрибут ресурса `service.name` — то, что Jaeger, Tempo и подобные показывают в списке сервисов). Раньше оно было жестко `sglang` во всех процессах, и несколько инстансов в одном коллекторе сливались в один сервис. Теперь порядок такой: этот флаг → переменная окружения `OTEL_SERVICE_NAME` → `sglang`. Без `--enable-trace` значение не читается. Флаг новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Service name for OTLP traces (displayed as 'service.name' in trace backends). If unset, falls back to the OTEL_SERVICE_NAME env var, then to 'sglang'.
```

## Паспорт аргумента

- Флаги: `--otlp-service-name`
- Группа: `observability`
- Тип значения: optional str
- Допустимые значения: любая строка
- Значение по умолчанию: `null` (не задан)
- Эффективное значение: ни один шаг резолва его не декларирует; подстановка `OTEL_SERVICE_NAME` / `sglang` делается при инициализации трассировки в каждом процессе
- Где объявлен: `python/sglang/srt/arg_groups/fields/observability.py:Observability.otlp_service_name`
- Статус: обычный
- Этап применения: `process_tracing_init` в каждом процессе, участвующем в трассировке (tokenizer manager, HTTP-сервер, scheduler на каждом rank'е, DP-контроллер, encode-сервер EPD)

## Что меняет в движке

Все пять точек инициализации (`entrypoints/engine.py`, `entrypoints/http_server.py`, `managers/scheduler.py`, `managers/data_parallel_controller.py`, `disaggregation/encoder/runtime.py`) при `--enable-trace` вызывают

```python
process_tracing_init(otlp_traces_endpoint, otlp_service_name, trace_modules=trace_modules)
```

Внутри (`observability/trace.py`):

```python
service_name = server_name or os.getenv("OTEL_SERVICE_NAME", "sglang")
resource = Resource.create(attributes={SERVICE_NAME: service_name})
```

Ресурс с этим именем получает `TracerProvider` процесса, то есть все спаны всех процессов инстанса идут под одним `service.name`. При `SGLANG_TRACE_ASYNC=1` то же имя передается асинхронному экспортеру (`start_trace_exporter`). Роль и ранги процесса по-прежнему различаются меткой потока (`Prefill Scheduler`, `Decode Tokenizer` и т. п.), а не именем сервиса.

## Значения и формат

- Любая строка; рекомендуется короткое имя без пробелов, по которому инстанс узнается в коллекторе, например `sglang-qwen3-prefill`.
- Пустая строка ведет себя как «не задан»: условие `server_name or …` пропускает ее к `OTEL_SERVICE_NAME`.
- Переменная `OTEL_SERVICE_NAME` действует только при незаданном флаге; флаг сильнее.
- Без `--enable-trace` значение принимается и попадает в дамп `server_args=`, но ни на что не влияет.

## Когда использовать

- Несколько инстансов SGLang (разные модели, prefill и decode PD-пары) пишут в один коллектор, и нужно отфильтровать трассы конкретного.
- Окружение процесса трудно менять, а `OTEL_SERVICE_NAME` уже занята под другой сервис в том же контейнере.
- Не нужен, если инстанс один или имя уже задано через `OTEL_SERVICE_NAME`.

## Влияние на производительность и память

Не влияет: меняется только строковый атрибут ресурса, который экспортер один раз прикрепляет к батчам спанов.

## Взаимодействие с другими аргументами

- `--enable-trace`: единственное условие, при котором значение читается.
- `--otlp-traces-endpoint`: адрес коллектора, куда уходят спаны с этим именем; передается в тот же вызов `process_tracing_init`.
- `--trace-modules`: фильтрует подсистемы, порождающие спаны; с именем сервиса не связан.
- `--disaggregation-mode`: prefill и decode инстансы PD-пары удобно называть по-разному, иначе их спаны различаются только метками потоков.

## Типовые проблемы и диагностика

- В коллекторе по-прежнему `sglang` — флаг не дошел до процесса (проверьте дамп `server_args=` на `otlp_service_name=`) либо установленная сборка старше checkout'а и хардкодит имя. В последнем случае флаг будет отвергнут argparse как неизвестный — это видно сразу при старте.
- Имя пришло не то, что ожидалось, хотя флаг не задан — в окружении процесса установлена `OTEL_SERVICE_NAME`.
- Ошибки инициализации (`opentelemetry package is not installed!!!`, `initialize opentelemetry error`) к имени не относятся — см. `--enable-trace` и `--otlp-traces-endpoint`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-trace --otlp-traces-endpoint 127.0.0.1:4317 --otlp-service-name sglang-qwen3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --disaggregation-mode prefill --enable-trace --otlp-traces-endpoint 127.0.0.1:4317 --otlp-service-name sglang-qwen3-prefill
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/observability.py`
- `sglang/python/sglang/srt/observability/trace.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/disaggregation/encoder/runtime.py`
