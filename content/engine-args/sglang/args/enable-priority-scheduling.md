---
schema: 1
engine: sglang
primaryName: "--enable-priority-scheduling"
title: "--enable-priority-scheduling"
summary: Включает приоритетное планирование по полю `priority` в теле запроса. Требует `--schedule-policy fcfs` или `lof` и практически всегда — `--default-priority-value`; головной флаг всего семейства приоритетов.
group: schedule
related:
  - --default-priority-value
  - --disable-priority-preemption
  - --abort-on-priority-when-disabled
  - --schedule-low-priority-values-first
  - --priority-scheduling-preemption-threshold
  - --retraction-policy
  - --schedule-policy
  - --max-queued-requests
  - --radix-eviction-policy
---

# --enable-priority-scheduling

## Кратко

`--enable-priority-scheduling` заставляет планировщик учитывать целочисленный `priority`, который клиент передает в теле запроса. Флаг головной: остальные аргументы семейства (`--default-priority-value`, `--disable-priority-preemption`, `--schedule-low-priority-values-first`, `--priority-scheduling-preemption-threshold`, `--retraction-policy priority`) без него либо игнорируются с предупреждением, либо приводят к отказу на старте. По умолчанию включенный приоритет означает и **вытеснение** уже считающихся запросов, а не только переупорядочивание очереди.

## Оригинальная справка

```text
Enable priority scheduling. Requests with higher priority integer values will be scheduled first by default.
```

## Паспорт аргумента

- Флаги: `--enable-priority-scheduling`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется автоматикой; отказывает на старте при несовместимой `--schedule-policy`
- Где объявлен: `ServerArgs.enable_priority_scheduling`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `_handle_other_validations` (проверки) → `TokenizerManager` (подстановка дефолтного приоритета) → `Scheduler` (очередь, вытеснение, метрики)

## Требуемая комбинация

Это единственное место, где комбинация описана целиком; остальные документы семейства ссылаются сюда.

1. `--enable-priority-scheduling` — обязателен.
2. `--schedule-policy` обязан быть `fcfs` или `lof`. Любое другое значение — отказ на старте: `To use priority scheduling, schedule_policy must be 'fcfs' or 'lof'. 'X' is not supported.`
3. `--default-priority-value N` — фактически обязателен. Без него движок печатает предупреждение, а запросы без явного `priority` получают в scheduler'е наихудший возможный приоритет (`-sys.maxsize - 1`, либо `sys.maxsize` при `--schedule-low-priority-values-first`) и метку `priority="None"` в Prometheus.
4. Направление задает `--schedule-low-priority-values-first`: по умолчанию выигрывает **большее** число, с флагом — меньшее.
5. Вытеснение включено по умолчанию; отключается `--disable-priority-preemption`, порог разницы приоритетов задает `--priority-scheduling-preemption-threshold` (по умолчанию 10).
6. `--retraction-policy priority` требует этого флага: иначе `ValueError: --retraction-policy priority requires --enable-priority-scheduling`.
7. `--abort-on-priority-when-disabled` — противоположный сценарий: он нужен на серверах, где приоритетное планирование **выключено**, и осмысленно задавать его только без этого флага.

## Что меняет в движке

- `TokenizerManager._set_default_priority` подставляет `--default-priority-value` в запрос, у которого `priority` не задан.
- `Scheduler._set_or_validate_priority` для оставшихся `None` подставляет крайнее значение (наихудший приоритет).
- `SchedulePolicy` строится с флагом приоритета и сортирует `waiting_queue` с учетом `priority` поверх выбранной политики (`fcfs`/`lof`).
- `_abort_on_queued_limit` (см. `--max-queued-requests`) при переполнении очереди выбрасывает не входящий запрос, а наименее приоритетный из очереди, если входящий строго лучше.
- `Scheduler.enable_priority_preemption = enable_priority_scheduling and not disable_priority_preemption`. Когда он включен, флаг `batch_is_full` сбрасывается перед каждым проходом планирования, чтобы дать шанс `PrefillAdder.preempt_to_schedule`: тот сортирует running-запросы от наименее предпочтительных, набирает из них столько, чтобы освободить нужное число токенов, и требует, чтобы разница приоритетов строго превышала порог. Вытесненные запросы возвращаются в очередь и позже продолжатся с префикс-кеша.
- Метрики: при включенном флаге к меткам токенайзера добавляется `priority`, и по нему разбиваются гистограммы времени ответа.

Клиент задает приоритет полем `priority` в JSON-теле: оно объявлено в `CompletionRequest`, `ChatCompletionRequest` и в нативном `GenerateReqInput`. Через прокси arriero это поле проходит как часть тела запроса.

## Значения и формат

- Флаг без значения. «Не задан» — приоритеты полностью игнорируются, и поле `priority` в теле запроса не влияет ни на что (если только не задан `--abort-on-priority-when-disabled`, который такие запросы обрывает).
- Сам приоритет — произвольное целое (в том числе отрицательное); шкала не нормируется.
- Порог `--priority-scheduling-preemption-threshold` сравнивается строго: вытеснение происходит при `разница > порога`, то есть при пороге 10 разница 10 еще не даст вытеснения.

## Когда использовать

- Когда на одном инстансе живут интерактивная и фоновая нагрузки, и интерактивная должна обгонять фон, а не ждать его.
- Когда очередь ограничена `--max-queued-requests` и в перегрузке нужно отбрасывать именно фон.
- Не включайте, если весь трафик однороден: приоритетный режим добавляет сортировку очереди, а при включенном вытеснении — периодические сбросы `batch_is_full` и повторные проходы planner'а.
- Не включайте на сервере, доступном не только с localhost, без контроля источника: `priority` — обычное поле тела запроса, аутентификации у него нет, и любой клиент может назначить себе максимальный приоритет. В arriero фильтровать источники нужно на уровне прокси (request sources, `docs/API_PROXY_FOUNDATION.md`), а не рассчитывать на движок.

## Влияние на производительность и память

- Память не затрагивается: ни один пул от флага не зависит.
- Накладные расходы планирования растут: сортировка очереди на каждом проходе плюс, при включенном вытеснении, дополнительный проход по running batch.
- Вытеснение стоит дорого по throughput: вытесненный запрос теряет незакешированную часть работы и позже пересчитывает ее (частично — с префикс-кешем).
- Latency высокоприоритетных запросов улучшается ровно за счет низкоприоритетных.

## Взаимодействие с другими аргументами

- `--schedule-policy`: допустимы только `fcfs` и `lof`; проверяется ассертом на старте.
- `--default-priority-value`: без него запросы без приоритета проваливаются в самый низ.
- `--schedule-low-priority-values-first`: переворачивает направление сравнения везде — в очереди, в вытеснении и в отбрасывании из очереди.
- `--disable-priority-preemption`: оставляет только переупорядочивание.
- `--priority-scheduling-preemption-threshold`: минимальная разница для вытеснения.
- `--retraction-policy priority`: связывает порядок ретракции при переполнении KV-пула с той же шкалой; требует этого флага.
- `--radix-eviction-policy priority`: отдельная шкала для вытеснения из radix-кеша, свою совместимость проверяет самостоятельно.
- `--max-queued-requests`: меняет семантику переполнения очереди.
- `--disaggregation-mode`: в decode-режиме приоритет учитывается в собственных очередях disaggregation.

## Типовые проблемы и диагностика

- `AssertionError: To use priority scheduling, schedule_policy must be 'fcfs' or 'lof'.` — уберите `--schedule-policy lpm` (или другой) либо откажитесь от приоритетов.
- Предупреждение `--default-priority-value is not set while --enable-priority-scheduling is enabled.` — задайте базовый приоритет, иначе в Prometheus появится метка `priority="None"`.
- Приоритеты «не работают» — проверьте, что клиент действительно шлет `priority` в теле, и что направление соответствует `--schedule-low-priority-values-first`.
- Высокоприоритетные запросы ждут, хотя вытеснение включено, — вероятно, разница приоритетов не превышает `--priority-scheduling-preemption-threshold`, либо вытеснение всех кандидатов не освобождает нужный объем токенов (тогда `preempt_to_schedule` возвращает `False` и ничего не делает).
- Низкоприоритетные запросы «пропадают» с 503 `The request is aborted by a higher priority request.` — это вытеснение из очереди при заданном `--max-queued-requests`.
- Принятые значения всего семейства видны в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --default-priority-value 0
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-policy lof --default-priority-value 100 --priority-scheduling-preemption-threshold 50 --retraction-policy priority
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
