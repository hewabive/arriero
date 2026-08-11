---
schema: 1
engine: vllm
primaryName: "--collect-detailed-traces"
title: "--collect-detailed-traces"
summary: Запрашивает подробные тайминги forward и execute в OTLP-трейсах. Требует заданного `--otlp-traces-endpoint`; в текущем коде V1-движка соответствующие атрибуты span'а не формируются, поэтому флаг работает как объявление намерения, а не как переключатель данных.
group: ObservabilityConfig
related:
  - --otlp-traces-endpoint
  - --enable-per-request-metrics
  - --enable-logging-iteration-details
  - --enable-mfu-metrics
---

# --collect-detailed-traces

## Кратко

Флаг задумывался как «включить дорогие тайминги внутри forward»: `ObservabilityConfig` выводит из него два признака — `collect_model_forward_time` и `collect_model_execute_time`, — которые в архитектуре V0 включали атрибуты `gen_ai.latency.time_in_model_forward` и `gen_ai.latency.time_in_model_execute` и одноимённые гистограммы.

В checkout'е, по которому снят extract, у обоих признаков **нет ни одного потребителя**: константы `SpanAttributes.GEN_AI_LATENCY_TIME_IN_MODEL_FORWARD` и `..._EXECUTE` объявлены, но нигде не присваиваются, а `OutputProcessor.do_tracing()` их не выставляет. Единственный наблюдаемый эффект флага сегодня — валидация: без `--otlp-traces-endpoint` он роняет старт.

## Оригинальная справка

```text
It makes sense to set this only if `--otlp-traces-endpoint` is set. If
set, it will collect detailed traces for the specified modules. This
involves use of possibly costly and or blocking operations and hence might
have a performance impact.

Note that collecting detailed timing information for each request can be
expensive.
```

## Паспорт аргумента

- Флаги: `--collect-detailed-traces`
- Группа argparse: `ObservabilityConfig`
- Тип значения: список строк (`nargs="+"`), допускается `None`
- Допустимые значения: в extract `choices: null` — набор достраивается в `add_cli_args()` и статически извлекателем не разрешён. Фактически argparse принимает `model`, `worker`, `all`, литерал `None` и все шесть упорядоченных пар этих трёх значений через запятую (`model,worker`, `all,model`, …). В `--help` вместо перечня печатается `metavar` вида `{all,model,worker,None}`, поэтому пар в подсказке не видно. Тройка через запятую (`all,model,worker`) в перечень не входит и будет отвергнута
- Значение по умолчанию: `null` (`None`)
- Эффективное значение: `_validate_collect_detailed_traces` разворачивает единственный элемент с запятой в список; `_validate_tracing_config` требует непустой `--otlp-traces-endpoint`
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.collect_detailed_traces`
- Этап применения: сборка `VllmConfig` (валидация и нормализация). Дальше по коду V1 значение не читается

## Что меняет в движке

`ObservabilityConfig` определяет два `cached_property`:

- `collect_model_forward_time` — истинно, если в списке есть `model` или `all`;
- `collect_model_execute_time` — истинно, если в списке есть `worker` или `all`.

Поиск по checkout'у (`grep -rn "collect_model_forward_time\|collect_model_execute_time"`) находит только их объявления. То же для констант атрибутов: `grep -rn "GEN_AI_LATENCY_TIME_IN_MODEL_FORWARD"` даёт единственное вхождение — определение в `vllm/tracing/utils.py`. Соответственно span `llm_request` выставляет только фазовые тайминги, которые собираются всегда: очередь, prefill, decode, inference, e2e и TTFT.

Описание в `vllm/docs/design/metrics.md` (§ «OpenTelemetry Model Forward vs Execute Time») относится к прежней реализации и перечисляет метрики `vllm:model_forward_time_milliseconds` и `vllm:model_execute_time_milliseconds`, которых в текущем `vllm/v1/metrics/loggers.py` нет. При расхождении прав код, а не документация.

Из наблюдаемых эффектов остаётся валидация: `collect_detailed_traces` без `otlp_traces_endpoint` даёт `ValueError: collect_detailed_traces requires --otlp-traces-endpoint to be set.` на сборке конфига, до загрузки весов.

## Значения и формат

- Несколько значений через пробел (`--collect-detailed-traces model worker`) или одна строка через запятую (`--collect-detailed-traces model,worker`) — второй вариант нормализуется валидатором в список.
- `all` — синоним «и forward, и execute».
- `None` принимается парсером и равнозначен отсутствию аргумента; при этом требование `--otlp-traces-endpoint` не срабатывает, поскольку список пустой.
- Комбинация из трёх значений через запятую не входит в перечень: используйте `all` или пробелы.

## Когда использовать

- Сегодня — только чтобы зафиксировать намерение в конфигурации инстанса на будущее, понимая, что данных флаг не добавляет.
- Для разбора latency используйте то, что реально работает: фазовые атрибуты span'а `llm_request` (`--otlp-traces-endpoint`), `--enable-per-request-metrics` или пошаговый лог `--enable-logging-iteration-details`.
- Если в вашей сборке ситуация иная (флаг был переработан), проверяйте по установленной версии: `grep -rn "collect_model_forward_time" <site-packages>/vllm` и наличие `vllm:model_forward_time_milliseconds` в `GET /metrics`.

## Влияние на производительность и память

В текущем коде V1 накладных расходов нет: значение не читается ни в горячем пути запроса, ни в воркере. Предупреждение справки о «costly and or blocking operations» описывает реализацию, которой в этом checkout'е нет; если она вернётся, стоимость — синхронизация с GPU для замера времени forward на каждом шаге, что заметно ударит по throughput.

## Взаимодействие с другими аргументами

- `--otlp-traces-endpoint`: обязателен при непустом значении; без него старт падает.
- `--enable-per-request-metrics`: рабочий способ получить per-request тайминги в метриках.
- `--enable-logging-iteration-details`: даёт пошаговое время итерации в логе движка — ближайший работающий аналог «детальных таймингов».
- `--enable-mfu-metrics`: даёт оценку загрузки железа за интервал, не привязанную к отдельному запросу.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: collect_detailed_traces requires --otlp-traces-endpoint to be set.` **Причина:** флаг задан без эндпоинта. **Лечение:** добавить `--otlp-traces-endpoint` либо убрать флаг.
- **Симптом:** `argument --collect-detailed-traces: invalid choice: 'all,model,worker'`. **Причина:** тройка через запятую не входит в собранный перечень. **Лечение:** `--collect-detailed-traces all`.
- **Симптом:** флаг задан, эндпоинт задан, а в трейсах нет `gen_ai.latency.time_in_model_forward`. **Причина:** в этом коммите атрибут не выставляется. **Проверка:** `grep -rn "GEN_AI_LATENCY_TIME_IN_MODEL_FORWARD" <site-packages>/vllm` — если единственное вхождение в `tracing/utils.py`, потребителя нет. **Лечение:** пользоваться фазовыми таймингами span'а.
- **Подтверждение принятого значения:** сам факт успешного старта с этим флагом означает лишь, что валидация прошла; отдельной строки в логе нет.

## Примеры

```bash
vllm serve /models/Qwen3-4B --otlp-traces-endpoint grpc://127.0.0.1:4317 --collect-detailed-traces all
```

```bash
vllm serve /models/Qwen3-4B --otlp-traces-endpoint grpc://127.0.0.1:4317 --collect-detailed-traces model worker
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/tracing/utils.py`
- `vllm/vllm/v1/engine/output_processor.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/docs/design/metrics.md`
