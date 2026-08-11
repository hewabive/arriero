---
schema: 1
engine: sglang
primaryName: "--schedule-low-priority-values-first"
title: "--schedule-low-priority-values-first"
summary: Переворачивает направление приоритетной шкалы: вперед идут запросы с меньшим числовым значением `priority`. Влияет одновременно на очередь, на preemption и на retraction; без `--enable-priority-scheduling` не читается.
group: schedule
related:
  - --enable-priority-scheduling
  - --priority-scheduling-preemption-threshold
  - --retraction-policy
  - --default-priority-value
  - --schedule-policy
  - --disable-priority-preemption
---

# --schedule-low-priority-values-first

## Кратко

По умолчанию SGLang считает, что больше — важнее: запрос с `priority: 100` обслуживается раньше, чем с `priority: 1`. Флаг переворачивает шкалу в привычную многим «единица — высший приоритет». Один флаг согласованно меняет направление во всех трех местах, где приоритет используется: сортировка очереди, выбор жертв preemption и выбор жертв retraction.

## Оригинальная справка

```text
If specified with --enable-priority-scheduling, the scheduler will schedule requests with lower priority integer values first.
```

## Паспорт аргумента

- Флаги: `--schedule-low-priority-values-first`
- Группа: `schedule`
- Тип значения: булев флаг (`store_true`), значения не принимает
- Допустимые значения: наличие/отсутствие флага
- Значение по умолчанию: `false` — больший `priority` обслуживается первым
- Эффективное значение: не переопределяется; без `--enable-priority-scheduling` значение сохраняется, но нигде не читается (предупреждения при этом не печатается)
- Где объявлен: `ServerArgs.schedule_low_priority_values_first`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание `SchedulePolicy` при инициализации планировщика → сортировка очереди на каждом проходе → `preempt_to_schedule` → `retract_decode`

## Что меняет в движке

Флаг превращается в `priority_sign` (`SchedulePolicy.__init__`, `sglang/python/sglang/srt/managers/schedule_policy.py`):

```python
self.priority_sign = 1 if schedule_low_priority_values_first else -1
```

Дальше знак используется в четырех местах:

- `_sort_by_priority_and_fcfs` — ключ `(priority * sign, время постановки в очередь)` для политики `fcfs`;
- `_sort_by_longest_output` — ключ `(priority * sign, -max_new_tokens)` для политики `lof`;
- `preempt_to_schedule` — сортировка работающих запросов и расчет `priority_diff = (req.priority - running.priority) * (-sign)`;
- `ScheduleBatch._get_decode_retraction_order` при `--retraction-policy priority` — тот же принцип для выбора жертв.

Второй эффект — значение по умолчанию для запросов без приоритета. `Scheduler._set_or_validate_priority` подставляет `sys.maxsize` при включенном флаге и `-sys.maxsize - 1` при выключенном. В обоих случаях это «самый низкий приоритет», то есть безымянные запросы всегда обслуживаются последними и вытесняются первыми. Этот путь срабатывает, только если приоритет не проставлен раньше: при заданном `--default-priority-value` подстановку делает tokenizer manager.

## Значения и формат

- Флаг без значения. Задан — меньшее число важнее; не задан — большее число важнее.
- Шкала целочисленная, отрицательные значения приоритета допустимы.
- Флаг не меняет саму политику (`--schedule-policy`), только направление вторичного ключа сортировки по приоритету.
- Менять направление на живом сервере нельзя: значение читается один раз при инициализации планировщика.

## Когда использовать

- Ваш клиентский протокол уже использует конвенцию «1 — высший приоритет» (как в очередях задач или в nice-подобных шкалах) — включайте, чтобы не переворачивать значения на стороне клиента.
- Приоритет выражает срок или стоимость, где меньше значит важнее (например, дедлайн в секундах).
- Не включайте «на всякий случай»: направление влияет и на выбор жертв вытеснения, и незаметная смена знака переворачивает поведение всей приоритетной схемы.
- Не используйте без `--enable-priority-scheduling` — флаг будет проигнорирован молча.

## Влияние на производительность и память

- На память и на объем работы не влияет: меняется только порядок и направление сравнения.
- Косвенно влияет на распределение latency между классами трафика — ровно на то, ради чего включается priority scheduling.
- На время старта, VRAM и RAM влияния нет.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: обязателен, иначе флаг мертвый.
- `--default-priority-value`: задает приоритет запросам без явного значения; без него они получают крайнее «самое низкое» значение в выбранном направлении.
- `--priority-scheduling-preemption-threshold`: разница приоритетов считается с учетом знака, так что порог работает одинаково в обоих направлениях.
- `--retraction-policy priority`: использует то же направление — приоритетная схема остается согласованной между допуском и снятием.
- `--schedule-policy`: при priority scheduling допустимы только `fcfs` и `lof`; флаг добавляет приоритет как старший ключ к обеим.
- `--disable-priority-preemption`: убирает вытеснение, оставляя только приоритетную сортировку очереди.

## Типовые проблемы и диагностика

- Приоритеты «работают наоборот» — проверьте наличие флага в дампе `server_args=` при старте; это первый кандидат на ошибку конфигурации.
- Запросы без приоритета всегда идут последними — ожидаемое поведение; задайте `--default-priority-value`, чтобы поместить их в середину шкалы. Без него при старте печатается предупреждение `--default-priority-value is not set while --enable-priority-scheduling is enabled. …`.
- Флаг задан, эффекта нет — нет `--enable-priority-scheduling`; предупреждения на этот случай в коде нет.
- Распределение приоритетов в обслуженном трафике видно в метриках при `--enable-metrics`: метки `priority` проставляются и на стороне tokenizer manager, и в счетчиках планировщика.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-policy fcfs --schedule-low-priority-values-first --default-priority-value 100
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-policy lof --schedule-low-priority-values-first --retraction-policy priority --priority-scheduling-preemption-threshold 20
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
