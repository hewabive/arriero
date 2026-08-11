---
schema: 1
engine: sglang
primaryName: "--enable-request-time-stats-logging"
title: "--enable-request-time-stats-logging"
summary: Печатает по одной строке `ReqTimeStats(...)` на каждый завершенный запрос: время в очереди, время forward, длины входа и выхода. Ни Prometheus, ни содержимого запроса — только тайминги в лог scheduler'а.
group: observability
related:
  - --enable-metrics
  - --log-requests
  - --log-requests-level
  - --decode-log-interval
  - --export-metrics-to-file
  - --disaggregation-mode
  - --log-level
---

# --enable-request-time-stats-logging

## Кратко

Самый дешевый способ увидеть, где именно каждый запрос провел время: в очереди планировщика или в forward. При завершении запроса scheduler печатает одну строку `INFO` вида `ReqTimeStats(rid=…, input_len=…, cached_input_len=…, output_len=…, attempts=…, type=unified): queue_duration=12.34ms, forward_duration=567.89ms, entry_time=…`. Prometheus для этого не нужен, `--enable-metrics` тоже. Содержимое запроса не печатается — только идентификатор и числа, поэтому включать флаг безопаснее, чем `--log-requests`. Плата — одна строка на запрос в файле лога.

## Оригинальная справка

```text
Enable per request time stats logging
```

## Паспорт аргумента

- Флаги: `--enable-request-time-stats-logging`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; парной формы `--no-*` не существует
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает. Печатает только ранг с `attn_tp_rank == 0`
- Где объявлен: `ServerArgs.enable_request_time_stats_logging`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: поток вывода scheduler'а, на завершении каждого запроса

## Что меняет в движке

Единственная точка чтения — `SchedulerOutputStreamer._maybe_log_time_stats` (`sglang/python/sglang/srt/managers/scheduler_components/output_streamer.py`):

```python
if req.finished() and self.ps.attn_tp_rank == 0 and get_observability().enable_request_time_stats_logging:
    req.log_time_stats()
```

`Req.log_time_stats()` (`sglang/python/sglang/srt/managers/schedule_batch.py`) защищен флагом `has_log_time_stats`, поэтому строка печатается ровно один раз на запрос даже при overlap-планировании, когда метод вызывается дважды.

Префикс строки постоянен: `rid`, `bootstrap_room` (только в PD-режиме), `input_len` (длина `origin_input_ids`), `cached_input_len` (сколько токенов взято из radix-кеша), `output_len`, `attempts` (число попыток prefill — растет при retract'ах) и `type` — `unified`, `prefill` или `decode`.

Хвост строки формируется `ReqTimeStats.convert_to_duration()` и зависит от режима:

- обычный режим (`unified`): `queue_duration` — от постановки в очередь ожидания до входа в forward; `forward_duration` — от входа в forward до завершения; `entry_time` — абсолютное время постановки в очередь;
- `--disaggregation-mode prefill`: добавляются `bootstrap_duration` (или `bootstrap_queue_duration`), `transfer_speed`, `transfer_total`;
- `--disaggregation-mode decode`: добавляются `prealloc_queue_duration` (или пара `bootstrap_duration` + `alloc_wait_duration`) и `transfer_duration`.

Длительности печатаются в миллисекундах с двумя знаками (`format_duration`), моменты — как абсолютное время с тремя знаками. Отрицательные и неинициализированные интервалы схлопываются в `0.0` (`duration_between` возвращает ноль, если любая из границ не заполнена).

## Значения и формат

- Флаг без значения; `--enable-request-time-stats-logging true` argparse не примет.
- Уровень записи — `INFO`. При `--log-level warning` строки исчезнут, флаг при этом останется включенным.
- Отключить у работающего сервера нельзя.
- Строка идет в лог scheduler-процесса, а не tokenizer-процесса; в объединенном stdout инстанса они соседствуют.
- `queue_duration` измеряется по `time.perf_counter()` внутри scheduler'а и **не включает** время, потраченное на токенизацию и передачу запроса от HTTP-слоя.

## Когда использовать

- Первым делом при разборе жалобы «сервер медленный»: разделение `queue_duration` и `forward_duration` сразу отвечает, упирается ли всё в конкуренцию (очередь) или в саму модель (forward). Ни одна агрегированная метрика этого по конкретному запросу не скажет.
- Когда подозреваете retract'ы: поле `attempts` больше единицы означает, что запрос выбивали из KV-пула и prefill повторялся.
- Когда нужно оценить эффективность префиксного кеша по конкретным запросам: `cached_input_len` относительно `input_len` — это и есть попадание в radix-кеш для данного запроса.
- В PD-режиме — чтобы увидеть цену передачи KV между стадиями отдельно от вычислений.
- Не включать на постоянку при высоком RPS без плана по логам: одна строка на запрос при 100 rps — это ~360 тысяч строк в час.
- Не использовать вместо `--log-requests`, если нужны параметры запроса: здесь их нет по конструкции.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: не затрагивает; тайминги и так собираются в `ReqTimeStats` независимо от флага, он влияет только на печать.
- Throughput: одно форматирование строки и одна синхронная запись в лог на завершенный запрос, в цикле scheduler'а. На запросах с сотнями токенов ответа это доли процента; на потоке очень коротких запросов заметно сильнее.
- Latency: строка печатается после завершения запроса и на его собственную задержку не влияет, но занимает цикл scheduler'а и потому слегка задевает соседей.
- Диск: линейно по числу запросов. Строка занимает порядка 150–250 байт.

## Взаимодействие с другими аргументами

- `--enable-metrics`: **не требуется**. Это независимый механизм; агрегат тех же величин в Prometheus — `sglang:queue_time_seconds` и `sglang:e2e_request_latency_seconds`, но там нет разбивки по конкретному запросу.
- `--log-requests` / `--log-requests-level`: соседний механизм, который печатает сам запрос и ответ. Пара «время без содержимого» против «содержимое»; включаются независимо.
- `--decode-log-interval`: агрегированная картина по батчам. Этот флаг дает пер-запросную, и вместе они закрывают обе стороны.
- `--disaggregation-mode`: меняет состав полей в хвосте строки.
- `--log-level`: строки идут на уровне `INFO`.
- `--export-metrics-to-file`: пишет похожие тайминги в структурированном виде на диск, но из tokenizer-процесса и вместе с содержимым запроса.

## Типовые проблемы и диагностика

- Флаг задан, строк нет — проверьте `--log-level` (нужен `info` или ниже) и то, что смотрите лог ранга с `attn_tp_rank == 0`. Подтверждение приема флага — `enable_request_time_stats_logging=True` в дампе `server_args=` при старте.
- `queue_duration=0.00ms` у всех запросов — очереди действительно нет, сервер не загружен. Это нормальный результат, а не сбой.
- `forward_duration` заметно больше, чем произведение числа выходных токенов на межтокенную задержку — в интервал попали ожидания при конкуренции с другими запросами в батче.
- `attempts=3` и большие `queue_duration` — KV-пул мал для текущей нагрузки; смотрите `token usage` в строках `Decode batch, …` и `--mem-fraction-static`.
- Все длительности нулевые в PD-режиме — соответствующие временные метки не были заполнены (`duration_between` возвращает ноль при незаполненной границе); значит, запрос не прошел эту фазу.
- **В arriero:** строки попадут в фильтрованный лог инстанса как есть — фильтр менеджера (`apps/api/src/process/log-filter.ts`) вырезает только рутинные probe-строки llama.cpp и к SGLang не применяется. Сопоставить `rid` движка с трейсом прокси arriero нельзя: у менеджера свой `traceId`, и общего идентификатора между ними нет. Сопоставлять придется по времени.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-request-time-stats-logging
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-request-time-stats-logging --decode-log-interval 10 --log-level info
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler_components/output_streamer.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/observability/req_time_stats.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
