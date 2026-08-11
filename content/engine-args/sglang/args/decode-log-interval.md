---
schema: 1
engine: sglang
primaryName: "--decode-log-interval"
title: "--decode-log-interval"
summary: Через сколько decode-итераций scheduler печатает строку `Decode batch, …` и обновляет «тяжелые» Prometheus-метрики. Определяет и частоту строк в логе, и дискретность gauge'ев занятости KV-пула.
group: observability
related:
  - --enable-metrics
  - --enable-mfu-metrics
  - --enable-metrics-for-all-schedulers
  - --log-level
  - --speculative-algorithm
  - --max-running-requests
  - --load-snapshot-publish-interval
---

# --decode-log-interval

## Кратко

Единственный счетчик, который управляет периодической частью отчета scheduler'а. Каждую decode-итерацию инкрементируется `forward_ct_decode`; когда он делится на `--decode-log-interval` нацело, движок собирает строку `Decode batch, #running-req: …, token usage: …, gen throughput (token/s): …, #queue-req: …` и обновляет набор gauge'ев в Prometheus. Между этими моментами обновляются только счетчики токенов реального времени. Значение по умолчанию 40 — то есть на быстром decode строка появляется несколько раз в секунду, а на медленном гибридном профиле может не появляться минутами.

## Оригинальная справка

```text
The log and metrics reporting interval (in decode iterations) for decode batches.
```

## Паспорт аргумента

- Флаги: `--decode-log-interval`
- Группа: `observability`
- Тип значения: int (число decode-итераций)
- Допустимые значения: `choices` нет, границы не проверяются. Значение `0` приводит к делению на ноль на первой же decode-итерации
- Значение по умолчанию: `40`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.decode_log_interval`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `SchedulerMetricsReporter` (значение копируется в поле) → каждая decode-итерация

## Что меняет в движке

### Разделение на «каждую итерацию» и «периодически»

`report_decode_stats` (`sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`) устроен в два слоя.

На **каждой** decode-итерации, если метрики scheduler'а включены: `increment_realtime_tokens(...)` (счетчик сгенерированных токенов), при `--enable-mfu-metrics` — накопление расчетных FLOPs и байтов, при включенном через переменную окружения status-логгере — его дамп.

Дальше стоит гейт:

```python
if self.forward_ct_decode % self.decode_log_interval != 0:
    return
```

и всё остальное выполняется только на кратных итерациях:

- считается `gap_latency` — время с прошлого отчета, из него `gen throughput (token/s)`;
- запрашивается `pool_stats_observer.get_pool_stats()` и формируется часть строки про `token usage`;
- при спекулятивном декодировании усредняются и **обнуляются** накопители `accept len` / `accept rate`;
- собирается и печатается строка `Decode batch, …` (только на ранге `attn_tp_rank == 0`);
- обновляется `SchedulerStats` — `num_running_reqs`, `num_queue_reqs`, `token_usage`, `cache_hit_rate`, `gen_throughput`, retract-счетчики, метрики HiCache и LoRA — и уходит в Prometheus.

### Что еще завязано на это значение

- При `--enable-mfu-metrics` накопленные FLOPs и байты делятся на `gap_latency`, то есть числа в логе усреднены ровно по этому окну, а `_decode_sol_suffix` получает `gap_latency / decode_log_interval` как оценку длительности одной итерации.
- Окно измерения загрузки GPU (`fwd_occupancy`, включается переменной окружения `SGLANG_ENABLE_METRICS_DEVICE_TIMER`) сбрасывается каждые `decode_log_interval` батчей — то же значение задает его длину.
- При включенной записи времени шага (`RECORD_STEP_TIME`) `gap_latency / decode_log_interval` записывается как длительность одного шага для данного размера батча.

Prefill-строка (`Prefill batch, …`) этому интервалу **не** подчиняется: она печатается на каждом prefill-батче.

## Значения и формат

- Целое число итераций, не секунд. Реальный период в секундах равен `decode_log_interval × длительность decode-шага`, а она меняется с размером батча и длиной контекста.
- `0` недопустим: `forward_ct_decode % 0` даст `ZeroDivisionError` в scheduler-процессе на первой decode-итерации. Аргумент это не проверяет.
- `1` — отчет на каждой итерации. Полностью рабочий режим для отладки, но лог растет на сотни строк в секунду.
- Отрицательные значения argparse примет; в Python `x % -40 == 0` для тех же `x`, что и при `40`, так что поведение совпадет с абсолютной величиной. Полагаться на это не стоит.
- Верхней границы нет. Очень большое значение фактически выключает и строку в логе, и обновление gauge'ев — метрики «замрут» на последних значениях.

## Когда использовать

- Уменьшать до 5–10 при отладке производительности: `gen throughput` и `token usage` становятся отзывчивыми, видно реакцию на изменение нагрузки. Особенно полезно на профиле KTransformers, где decode-шаг длинный и при дефолтных 40 итерациях между строками проходят десятки секунд.
- Уменьшать, если строите дашборд с шагом опроса 5–15 с: при дефолте и медленном decode Prometheus будет скрейпить один и тот же неизменившийся `token_usage` по нескольку раз подряд, и график станет ступенчатым.
- Увеличивать до 100–200 на сервере с высоким throughput и долгим хранением логов: при быстром decode строк получается несколько в секунду, и они заметно раздувают файл лога.
- Не выставлять `1` в продакшене: строка собирается конкатенацией десятка f-строк и печатается синхронно в цикле scheduler'а.
- Не пытаться получить этим аргументом «более точные метрики»: точность значений не меняется, меняется только частота их публикации.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: не затрагивает, кроме роста файла лога.
- Throughput: на кратных итерациях выполняется сбор статистики пулов, конкатенация строки и синхронная запись в лог. При значении по умолчанию это раз в 40 шагов и незаметно; при `1` — на каждом decode-шаге, и на маленьких батчах, где шаг занимает единицы миллисекунд, это уже измеримо.
- Latency: та же работа выполняется в цикле scheduler'а между forward'ами, поэтому очень маленький интервал добавляет джиттер к межтокенной задержке.
- Диск: объем лога прямо обратно пропорционален значению.

## Взаимодействие с другими аргументами

- `--enable-metrics`: без него Prometheus-часть отчета не выполняется, но **строка в логе печатается по-прежнему** — гейт логирования отдельный (`is_stats_logging_rank`). То есть аргумент полезен и без метрик.
- `--enable-mfu-metrics`: окно усреднения расчетных TFLOPS и полос — это именно `gap_latency` данного интервала.
- `--enable-metrics-for-all-schedulers`: теперь по этому интервалу отчитывается каждый ранг.
- `--speculative-algorithm`: `accept len` и `accept rate` усредняются и обнуляются ровно на границах интервала; при слишком большом значении эти числа станут малоинформативными средними по длинному окну.
- `--max-running-requests`: чем крупнее батч, тем длиннее одна итерация и тем реже в секундах срабатывает интервал.
- `--load-snapshot-publish-interval`: соседний счетчик итераций (публикация снимка загрузки в разделяемую память), независимый и со своим значением по умолчанию.
- `--log-level`: строка печатается через `logger.info`; при `--log-level warning` она исчезнет независимо от интервала.

## Типовые проблемы и диагностика

- Строк `Decode batch, …` нет вовсе при работающем сервере — либо `--log-level` выше `info`, либо decode еще не набрал нужного числа итераций (короткие ответы), либо вы смотрите лог не того ранга.
- `ZeroDivisionError: integer division or modulo by zero` в scheduler-процессе сразу после первого запроса — задан `--decode-log-interval 0`.
- `token usage` в Prometheus меняется скачками и «запаздывает» — это и есть дискретность интервала. Уменьшайте значение либо смотрите на `sglang:realtime_tokens_total`, который обновляется каждую итерацию.
- `gen throughput (token/s)` в первой строке после простоя абсурдно мал — `gap_latency` включает время простоя. Значение выравнивается на следующем интервале.
- Лог инстанса растет на гигабайты — уменьшите частоту, увеличив интервал; фильтрация arriero эти строки не трогает.
- **В arriero:** строки `Decode batch, …` попадают в фильтрованный лог инстанса целиком. Фильтр (`apps/api/src/process/log-filter.ts`) вырезает только рутинные probe-запросы llama.cpp по шаблону `done request:` и к строкам SGLang не применяется. Парсер лога SGLang (`apps/api/src/process/log-parsers/sglang.ts`) из них ничего не извлекает — он ищет готовность, путь модели и `max_total_num_tokens`. Так что уменьшение интервала прямо увеличивает объем `runtime/logs/` для инстанса и ничего не добавляет в UI.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --decode-log-interval 10
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --decode-log-interval 10 --enable-mfu-metrics
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/managers/scheduler_components/batch_result_processor.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
