---
schema: 1
engine: sglang
primaryName: "--disable-priority-preemption"
title: "--disable-priority-preemption"
summary: Оставляет приоритетам только переупорядочивание очереди и запрещает вытеснять уже считающиеся запросы. Читается только вместе с `--enable-priority-scheduling`.
group: schedule
related:
  - --enable-priority-scheduling
  - --priority-scheduling-preemption-threshold
  - --schedule-low-priority-values-first
  - --default-priority-value
  - --retraction-policy
  - --max-running-requests
---

# --disable-priority-preemption

## Кратко

При включенном приоритетном планировании вытеснение работает **по умолчанию**: высокоприоритетный запрос может выбить из running batch уже считающиеся низкоприоритетные, чтобы получить место немедленно. `--disable-priority-preemption` это отключает, оставляя приоритетам только порядок в очереди ожидания. Флаг имеет смысл исключительно в комбинации с `--enable-priority-scheduling` — весь требуемый набор описан там.

## Оригинальная справка

```text
Disable priority scheduling preemption.
```

## Паспорт аргумента

- Флаги: `--disable-priority-preemption`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false` — вытеснение включено
- Эффективное значение: не переопределяется; без `--enable-priority-scheduling` игнорируется с предупреждением
- Где объявлен: `ServerArgs.disable_priority_preemption`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `Scheduler.init_schedule_policy` → каждый проход `get_new_batch_prefill`

## Что меняет в движке

Флаг участвует ровно в одном выражении:

```python
self.enable_priority_preemption = self.enable_priority_scheduling and not disable_priority_preemption
```

Когда `enable_priority_preemption` истинно, планировщик делает два дополнительных действия на каждом проходе:

- сбрасывает `running_batch.batch_is_full = False`, чтобы даже переполненный batch дал шанс попытке вытеснения;
- при заполненном batch'е вызывает `PrefillAdder.preempt_to_schedule(req, server_args)`. Тот сортирует running-запросы от наименее предпочтительных, набирает кандидатов, у которых разница приоритетов строго больше `--priority-scheduling-preemption-threshold`, и коммитит вытеснение только если освобождаемых токенов хватает для нового запроса. Вытесненные запросы освобождают KV и возвращаются в `waiting_queue`.

С флагом обе ветки выключаются: `batch_is_full` работает как обычно, `preempt_to_schedule` не вызывается, и высокоприоритетный запрос просто становится первым в очереди.

## Значения и формат

- Флаг без значения; «не задан» означает включенное вытеснение.
- Обратного флага (`--enable-priority-preemption`) нет — вытеснение включается самим `--enable-priority-scheduling`.
- Задание флага без головного флага не является ошибкой: печатается `--disable-priority-preemption has no effect without --enable-priority-scheduling`, старт продолжается.

## Когда использовать

- Когда прерывание уже начатой генерации неприемлемо: длинные ответы, потоковые клиенты без ретраев, дорогие запросы, которые нельзя пересчитывать.
- Когда важнее предсказуемая пропускная способность, чем latency отдельного приоритетного запроса: вытеснение всегда означает потерянную работу.
- Когда вытеснение уже сработало и вы видите в логах повторную обработку одних и тех же запросов — сначала попробуйте поднять `--priority-scheduling-preemption-threshold`, и только если это не помогает, выключайте механизм целиком.
- Не нужен, если running batch редко бывает заполнен: вытеснение просто не активируется.

## Влияние на производительность и память

- На память не влияет.
- Уменьшает накладные расходы планировщика: снимается дополнительный проход по running batch и повторные попытки admission на переполненном batch'е.
- Повышает суммарный throughput под смешанной нагрузкой (нет потерянной работы), но ухудшает время до первого токена для высокоприоритетных запросов, когда batch полон.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: без него флаг игнорируется.
- `--priority-scheduling-preemption-threshold`: более мягкая альтернатива — оставить вытеснение, но потребовать большей разницы приоритетов.
- `--schedule-low-priority-values-first`, `--default-priority-value`: определяют, кто окажется кандидатом на вытеснение.
- `--retraction-policy priority`: отдельный механизм — вытеснение при переполнении KV-пула, а не при заполненном batch'е. Этот флаг его не отключает.
- `--max-running-requests`: чем меньше значение, тем чаще batch оказывается полным и тем заметнее разница между включенным и выключенным вытеснением.

## Типовые проблемы и диагностика

- Предупреждение `--disable-priority-preemption has no effect without --enable-priority-scheduling` — добавьте головной флаг или уберите этот.
- Высокоприоритетные запросы стали ждать дольше после включения флага — это ожидаемая цена; ускорить их можно только увеличением пропускной способности.
- Запросы все равно прерываются — проверьте `--retraction-policy` и переполнение KV-пула (`KV cache pool is full. Retract requests.`): ретракция при нехватке памяти работает независимо от этого флага.
- Принятое значение видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --default-priority-value 0 --disable-priority-preemption
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --default-priority-value 0 --priority-scheduling-preemption-threshold 100
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
