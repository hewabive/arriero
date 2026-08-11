---
schema: 1
engine: vllm
primaryName: "--enable-logging-iteration-details"
title: "--enable-logging-iteration-details"
summary: Пишет по одной строке лога на каждый шаг движка: число context/generation запросов и токенов, время итерации и загрузку KV-cache. Незаменим при разборе поведения планировщика и совершенно непригоден как постоянный режим.
group: ObservabilityConfig
related:
  - --disable-log-stats
  - --enable-log-requests
  - --enable-per-request-metrics
  - --cudagraph-metrics
  - --enable-mfu-metrics
  - --max-num-batched-tokens
  - --max-num-seqs
---

# --enable-logging-iteration-details

## Кратко

Обычный периодический лог vLLM печатает агрегаты раз в `VLLM_LOG_STATS_INTERVAL` секунд (по умолчанию 10). Этот флаг добавляет **строку на каждую итерацию** движка — то есть на каждый вызов `execute_model`, а не на каждый запрос.

Объём предсказуем: под decode-нагрузкой шаг занимает десятки миллисекунд, значит поток лога — десятки строк в секунду на каждый engine-процесс, и он не зависит от числа клиентов.

## Оригинальная справка

```text
Enable detailed logging of iteration details.
If set, vllm EngineCore will log iteration details
This includes number of context/generation requests and tokens
and the elapsed cpu time for the iteration.
```

## Паспорт аргумента

- Флаги: `--enable-logging-iteration-details`, `--no-enable-logging-iteration-details`
- Группа argparse: `ObservabilityConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: гасится при выключенной статистике — `EngineCore.capture_iteration_details()` проверяет `if not self.log_stats or not enable_details`, то есть с `--disable-log-stats` флаг не делает ничего и об этом не сообщает
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.enable_logging_iteration_details`
- Этап применения: планировщик (сбор статистики по энкодерным входам) → шаг движка (замер времени) → стат-логгер (печать строки)

## Что меняет в движке

**Сбор.** Шаг `EngineCore.step()` оборачивается контекст-менеджером `capture_iteration_details()`: он берёт `time.monotonic()` до и после выполнения шага и заполняет `SchedulerIterationDetails` — `iteration_index` (сквозной счётчик шагов), `num_ctx_requests`, `num_ctx_tokens`, `num_generation_requests`, `num_generation_tokens`, `elapsed_ms`, флаг `is_dummy` и, если были мультимодальные входы, `num_encoder_inputs` и `num_encoder_output_tokens`. Разбиение на «context» и «generation» считает `compute_iteration_details(scheduler_output)` по фактическому распределению запланированных токенов.

Шаги с нулём запланированных токенов пропускаются, чтобы не дублировать запись из обёртки dummy-батча; DP-заглушки помечаются `is_dummy=True`.

Дополнительно в `Scheduler.schedule()` при включённом флаге считается `_make_scheduled_encoder_input_stats(...)` — статистика по энкодерным входам этого шага.

**Печать.** `LoggingStatLogger.record()` вызывается на каждую пачку выходов движка, то есть фактически на каждый шаг, и первым делом вызывает `_log_iteration_details()`. Формат строки:

```text
Engine 000: Iteration(1234): 2 context requests, 4096 context tokens, 6 generation requests, 6 generation tokens, iteration elapsed time: 18.42 ms, GPU KV cache usage: 37.1%
```

К хвосту добавляется `, encoder inputs: N, encoder output embeddings: M` при мультимодальных входах и пометка ` (dummy)` для DP-заглушек. Уровень — `INFO`, поэтому строка попадает в лог при штатной конфигурации логирования.

Обратите внимание: `elapsed_ms` меряется вокруг всего шага в процессе EngineCore и включает ожидание результата исполнителя, а не только время forward на GPU.

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-enable-logging-iteration-details` эквивалентны.
- Значение не имеет градаций: либо каждая итерация, либо ничего. Прореживания или лимита строк нет.
- Совместно с `--disable-log-stats` бесполезен.

## Когда использовать

- Разбор поведения планировщика: видно, как chunked prefill делит длинный промпт, когда запросы вытесняются, какая доля шагов уходит на generation, растёт ли `elapsed_ms` при определённом составе батча.
- Подбор `--max-num-batched-tokens` и `--max-num-seqs`: соотношение context/generation токенов в строке — прямой сигнал.
- Диагностика «сервер жив, но медленно»: пустые или почти пустые итерации видны сразу.
- Не оставляйте включённым в постоянной эксплуатации: это десятки строк INFO в секунду, дополнительная нагрузка на диск и риск, что ротация лога затрёт важные события.
- Не используйте, чтобы понять поведение конкретного запроса: строка агрегирует шаг, а не запрос. Для запросов есть `--enable-log-requests` и `--enable-per-request-metrics`.

## Влияние на производительность и память

- **CPU движка.** Два `time.monotonic()` на шаг и один обход `scheduler_output` в `compute_iteration_details` — пренебрежимо на фоне forward. Основная цена — форматирование и запись строки лога на каждом шаге в процессе фронтенда.
- **Диск.** Основной риск. При 50 шагах/с строка длиной ~180 байт даёт порядка 9 КБ/с, то есть около 750 МБ в сутки на один engine-процесс. В arriero это пишется в `runtime/logs/` и попадает в фильтрованный лог инстанса.
- **VRAM.** Не влияет.
- **Latency.** Косвенно: синхронная запись в лог из цикла обработки выходов может добавить задержку, если лог пишется на медленное устройство.

## Взаимодействие с другими аргументами

- `--disable-log-stats`: полностью отключает механизм.
- `--enable-log-requests`, `--enable-per-request-metrics`: per-request альтернативы, дающие другую разрезку.
- `--cudagraph-metrics`: печатает свою таблицу раз в интервал; вместе с этим флагом даёт картину «шаг за шагом плюс сводка по паддингу».
- `--enable-mfu-metrics`: добавляет к периодическому логу оценку TF/s и GB/s за интервал.
- `--max-num-batched-tokens`, `--max-num-seqs`: то, что обычно и настраивают по этим строкам.
- Переменная окружения `VLLM_LOG_STATS_INTERVAL` управляет периодическим логом, но не этой построчной печатью.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, строк `Iteration(...)` нет. **Причина:** задан `--disable-log-stats`, либо уровень логирования выше `INFO`, либо движок простаивает (шаги без запросов не выполняются). **Проверка:** есть ли периодические строки `Avg prompt throughput: ...` — если и их нет, статистика отключена. **Лечение:** убрать `--disable-log-stats`.
- **Симптом:** лог инстанса растёт на сотни мегабайт в сутки. **Причина:** штатное поведение флага. **Лечение:** выключить после снятия наблюдения.
- **Симптом:** много строк с ` (dummy)`. **Причина:** DP-ранг выполняет холостые итерации, потому что у него нет запросов. **Лечение:** это диагностика балансировки data parallel, а не ошибка.
- **Симптом:** `elapsed_ms` заметно больше ожидаемого времени forward. **Причина:** замер охватывает весь шаг EngineCore, включая ожидание исполнителя. **Лечение:** для чистого времени ядра пользоваться профилировщиком, а не этой строкой.
- **Подтверждение принятого значения:** появление строк `Iteration(<n>): ...` в логе под нагрузкой.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-logging-iteration-details --max-num-batched-tokens 4096
```

```bash
vllm serve /models/Qwen3-4B --enable-logging-iteration-details --cudagraph-metrics --max-num-seqs 8
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/vllm/v1/metrics/stats.py`
- `vllm/vllm/v1/engine/async_llm.py`
- `vllm/vllm/envs.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
