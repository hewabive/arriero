---
schema: 1
engine: vllm
primaryName: "--aggregate-engine-logging"
title: "--aggregate-engine-logging"
summary: При data parallelism печатает одну сводную строку статистики вместо строки на каждый DP-ранг. На метрики Prometheus не влияет и при `--data-parallel-size 1` бессмыслен.
group: null
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --disable-log-stats
  - --api-server-count
---

# --aggregate-engine-logging

## Кратко

`--aggregate-engine-logging` меняет только форму консольного логгера статистики. Без него каждый DP-ранг печатает собственную строку с префиксом `Engine 000: `, `Engine 001: ` и так далее; с ним печатается одна строка с префиксом `N Engines Aggregated: `, где счетчики очередей просуммированы, а заполнение KV-cache усреднено.

Ни на Prometheus, ни на сбор статистики флаг не влияет — это чисто представление в логе. При одном ранге он не даст ничего, кроме смены префикса.

## Оригинальная справка

```text
Log aggregate rather than per-engine statistics when using data parallelism.
```

## Паспорт аргумента

- Флаги: `--aggregate-engine-logging`
- Группа argparse: без группы (объявлен напрямую в `EngineArgs.add_cli_args`)
- Тип значения: bool, `action="store_true"` — только включение, парного `--no-` флага нет
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `False` — статистика печатается по каждому движку отдельно
- Эффективное значение: не переопределяется, но не действует, если консольного логгера нет вовсе (`--disable-log-stats` либо `--api-server-count > 1`)
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: создание `StatLoggerManager` внутри `AsyncLLM.__init__`

## Что меняет в движке

Значение доходит до `StatLoggerManager` (`vllm/v1/metrics/loggers.py`) через `AsyncLLM` и участвует ровно в одном выборе:

```python
default_logger_factory = (
    AggregatedLoggingStatLogger if aggregate_engine_logging else LoggingStatLogger
)
```

`LoggingStatLogger` оборачивается в `PerEngineStatLoggerAdapter`, то есть создается по экземпляру на движок и печатает по строке на движок. `AggregatedLoggingStatLogger` — один объект на все движки: он хранит последние `SchedulerStats` каждого ранга в словаре, а перед выводом складывает `num_waiting_reqs`, `num_running_reqs`, `num_skipped_waiting_reqs` и **усредняет** `kv_cache_usage` по числу движков.

Две детали, о которых стоит знать заранее.

- Префикс строки становится `"{N} Engines Aggregated: "`, а внутренний `engine_index` у этого логгера равен `-1`. Любой парсер логов, ожидающий `Engine \d{3}`, на этом сломается.
- `_enable_perf_stats()` у агрегированного логгера возвращает `False` с прямым обоснованием в коде: суммировать per-GPU perf-метрики между движками бессмысленно. То есть часть детализации в агрегированном режиме не выводится вообще.

Пропускная способность (`Avg prompt throughput`, `Avg generation throughput`) считается через общий `_update_stats()` базового класса и в агрегированном виде отражает суммарный поток по всем движкам.

## Значения и формат

- Флаг без значения. Форма `--aggregate-engine-logging=true` не поддерживается.
- Из YAML через `--config` включается ключом `aggregate-engine-logging: true`; `false` молча отбрасывается, потому что `--no-` половины нет.

## Когда использовать

- При `--data-parallel-size` от 4 и выше, когда N строк на каждый интервал делают лог нечитаемым, а нужен один взгляд на общую загрузку.
- Когда лог читает человек, а не парсер: суммарные очереди и средний `GPU KV cache usage` дают правильную картину «загружен ли сервер целиком».
- **Не используйте, если нужно найти перекос между рангами.** Именно per-engine строки показывают, что один ранг стоит в очереди, а другой простаивает, — а это типичный симптом плохой балансировки. Агрегация этот перекос прячет по построению.
- Бессмысленно при `--data-parallel-size 1`: логгер будет один в любом случае, меняется только префикс.

## Влияние на производительность и память

На движок не влияет: разница в один объект логгера вместо N и в форматировании одной строки вместо N раз в `VLLM_LOG_STATS_INTERVAL` секунд. VRAM, throughput и latency не затрагиваются.

## Взаимодействие с другими аргументами

- `--data-parallel-size`, `--data-parallel-size-local`: определяют, сколько движков попадает в агрегат. При одном движке эффект нулевой.
- `--disable-log-stats`: полностью отменяет действие флага — консольного логгера не существует.
- `--api-server-count`: при значении больше 1 консольный логгер отключается автоматически (`AsyncLLM created with api_server_count more than 1; disabling stats logging to avoid incomplete stats.`), и флаг снова ни на что не влияет.
- Метрики Prometheus от него не зависят: `PrometheusStatLogger` в обоих случаях один и помечает ряды меткой движка.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, а строки по-прежнему начинаются с `Engine 000: `. **Причина:** движок один — агрегировать нечего, либо флаг не дошел (проверьте строку `non-default args:` при старте).
- **Симптом:** флаг задан, а строк статистики нет совсем. **Причина:** `--disable-log-stats` или `--api-server-count > 1`.
- **Симптом:** после включения пропала часть привычных полей. **Причина:** агрегированный логгер сознательно не выводит per-GPU perf-метрики. **Лечение:** вернуть per-engine режим или брать эти величины из `/metrics`.
- **Симптом:** внешний парсер логов перестал находить строки. **Причина:** сменился префикс на `N Engines Aggregated: `. **Лечение:** либо обновить парсер, либо перейти на `/metrics`, где формат стабилен.
- **Подтверждение принятого значения:** префикс `N Engines Aggregated: ` в периодической строке статистики.

## Примеры

```bash
vllm serve /models/Qwen3-4B --data-parallel-size 4 --aggregate-engine-logging
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-size 4 --aggregate-engine-logging --api-server-count 1
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/docs/serving/data_parallel_deployment.md`
