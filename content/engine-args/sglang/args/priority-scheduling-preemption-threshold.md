---
schema: 1
engine: sglang
primaryName: "--priority-scheduling-preemption-threshold"
title: "--priority-scheduling-preemption-threshold"
summary: Насколько приоритет входящего запроса должен превышать приоритет работающего, чтобы тот был вытеснен ради его допуска. Сравнение строгое: разница ровно в пороговое значение вытеснения не вызывает.
group: schedule
related:
  - --enable-priority-scheduling
  - --disable-priority-preemption
  - --schedule-low-priority-values-first
  - --default-priority-value
  - --retraction-policy
  - --schedule-policy
  - --abort-on-priority-when-disabled
---

# --priority-scheduling-preemption-threshold

## Кратко

При включенном priority scheduling планировщик может освободить место под входящий запрос, снимая с исполнения менее приоритетные. Порог задает минимальную разницу приоритетов, при которой это разрешено, и защищает от «пинг-понга» между запросами с почти одинаковым приоритетом. Аргумент читается только при `--enable-priority-scheduling`.

## Оригинальная справка

```text
Minimum difference in priorities for an incoming request to have to preempt running request(s).
```

## Паспорт аргумента

- Флаги: `--priority-scheduling-preemption-threshold`
- Группа: `schedule`
- Тип значения: целое
- Допустимые значения: не ограничены; проверок при старте нет
- Значение по умолчанию: `10`
- Эффективное значение: не переопределяется; `__post_init__` это поле не читает
- Где объявлен: `ServerArgs.priority_scheduling_preemption_threshold`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; без `--enable-priority-scheduling` не используется, предупреждения при этом не печатается
- Этап применения: передается в `PrefillAdder` при каждой сборке prefill-батча, используется в `preempt_to_schedule`

## Что меняет в движке

Preemption включается автоматически вместе с priority scheduling: `enable_priority_preemption = enable_priority_scheduling and not disable_priority_preemption` (`Scheduler.init_schedule_policy`). При включенной preemption планировщик на каждом проходе сбрасывает флаг `batch_is_full`, чтобы дать шанс на вытеснение, и когда батч все же оказывается полон, вызывает `adder.preempt_to_schedule(req, server_args)` вместо того, чтобы просто оборвать обход очереди.

Алгоритм `preempt_to_schedule` (`sglang/python/sglang/srt/managers/schedule_policy.py`):

1. работающие запросы сортируются от наименее приоритетных (при равенстве — от позже поставленных в очередь);
2. считается дефицит `min_tokens_to_remove` = длина непокрытого префикса входящего запроса + `min(max_new_tokens, 4096)` − `rem_total_tokens`;
3. кандидаты набираются по порядку, пока дефицит не закрыт; условие допуска кандидата — `priority_diff > threshold`, где `priority_diff = (req.priority - running_req.priority) * (-priority_sign)`;
4. первый же кандидат, не прошедший по порогу, обрывает набор (`break`) — список отсортирован, дальше будет только хуже;
5. если кандидатов нет или их суммарного резерва не хватает, preemption не происходит и обход очереди прерывается;
6. иначе KV снятых запросов освобождается немедленно, они удаляются из running-батча и возвращаются в очередь ожидания.

`priority_sign` равен `1` при `--schedule-low-priority-values-first` и `-1` иначе, поэтому формула работает одинаково в обоих направлениях: `priority_diff` — это всегда «насколько входящий важнее».

Сравнение **строгое**: при пороге `10` разница ровно в 10 единиц вытеснения не даст, нужна разница минимум 11.

## Значения и формат

- Целое число в тех же единицах, что и приоритет запроса (`priority` в теле запроса или заголовок `x-override-priority`).
- `0` означает «вытеснять при любой положительной разнице приоритетов» (разница должна быть строго больше нуля, то есть минимум 1).
- Отрицательные значения разрешают вытеснение и при равных, и при слегка меньших приоритетах — прямой путь к циклическому вытеснению; практического смысла не имеет.
- Большие значения фактически отключают preemption, не отключая приоритетную сортировку очереди; полностью выключить механизм можно флагом `--disable-priority-preemption`.
- Запросы, у которых приоритет не задан, получают крайнее значение (`sys.maxsize` при low-first, `-sys.maxsize - 1` иначе) в `_set_or_validate_priority` — с ними разница всегда огромная, и такие запросы вытесняются первыми.

## Когда использовать

- Есть два-три класса обслуживания с разнесенными значениями приоритета — оставьте умолчание `10` и разносите приоритеты классов шагом больше 10.
- Приоритет — непрерывная шкала (например, срок дедлайна в секундах) — поднимите порог, иначе соседние запросы будут вытеснять друг друга.
- Нужна приоритетная очередь без вытеснения — используйте `--disable-priority-preemption`, а не большой порог: так намерение явно видно в конфигурации.
- Не задавайте `0` на нагрузке с непрерывными приоритетами: цена вытеснения — полный пере-prefill снятого запроса.

## Влияние на производительность и память

- Память: preemption освобождает KV немедленно, но снятые запросы возвращаются в очередь и позже пере-prefill'ятся; общий объем работы растет.
- Низкий порог повышает частоту вытеснений и, следовательно, долю повторного prefill'а — throughput падает.
- Latency высокоприоритетного трафика улучшается: он не ждет освобождения слотов.
- Хвостовая latency низкоприоритетного трафика ухудшается вплоть до голодания, если поток высокоприоритетных запросов не иссякает.
- На VRAM, RAM и время старта влияния нет.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: обязателен; без него значение не читается.
- `--disable-priority-preemption`: полностью отключает механизм, порог становится неважен. Без priority scheduling этот флаг печатает предупреждение `--disable-priority-preemption has no effect without --enable-priority-scheduling`.
- `--schedule-low-priority-values-first`: задает направление разницы приоритетов.
- `--default-priority-value`: без него запросы без явного приоритета получают крайнее значение и становятся первыми кандидатами на вытеснение; при старте с priority scheduling и без этого аргумента печатается предупреждение.
- `--retraction-policy priority`: другой механизм — снятие запросов при нехватке KV в decode. Preemption работает на этапе допуска, retraction — на этапе генерации.
- `--schedule-policy`: при priority scheduling ограничен `fcfs` и `lof`.

## Типовые проблемы и диагностика

- Вытеснение не происходит вовсе: проверьте фактический разброс приоритетов — разница должна быть строго больше порога, а также что не задан `--disable-priority-preemption`.
- Вытеснение происходит слишком часто, throughput просел — поднимите порог; косвенный признак в логе — рост числа prefill'ов при неизменном числе завершенных запросов.
- Низкоприоритетные запросы не завершаются никогда — приоритетная схема без ограничения по времени ожидания; вытеснение здесь только усугубляет, рассмотрите `--disable-priority-preemption`.
- Приоритеты приходят, но игнорируются: без `--enable-priority-scheduling` они либо ничего не значат, либо (при `--abort-on-priority-when-disabled`) приводят к отказу запроса с 503.
- Принятое значение видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-policy fcfs --default-priority-value 0 --priority-scheduling-preemption-threshold 10
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-policy lof --schedule-low-priority-values-first --default-priority-value 100 --priority-scheduling-preemption-threshold 50
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/request_headers.py`
