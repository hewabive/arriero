---
schema: 1
engine: sglang
primaryName: "--default-priority-value"
title: "--default-priority-value"
summary: Приоритет для запросов, не указавших `priority` явно. Без него такие запросы получают наихудший возможный приоритет и метку `priority="None"` в метриках; читается только при `--enable-priority-scheduling`.
group: schedule
related:
  - --enable-priority-scheduling
  - --schedule-low-priority-values-first
  - --disable-priority-preemption
  - --priority-scheduling-preemption-threshold
  - --abort-on-priority-when-disabled
  - --max-queued-requests
---

# --default-priority-value

## Кратко

`--default-priority-value` задает базовую точку шкалы приоритетов: значение подставляется каждому запросу, в теле которого нет поля `priority`. Аргумент имеет смысл только в комбинации с `--enable-priority-scheduling` — требуемый набор флагов описан в документе этого флага. Без базового значения смешанный трафик получается несимметричным: явно размеченные запросы всегда обгоняют обычные, потому что обычные проваливаются на дно шкалы.

## Оригинальная справка

```text
Default priority for requests without explicit priority.
```

## Паспорт аргумента

- Флаги: `--default-priority-value`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: любое целое, включая отрицательные и `0`; ограничений в argparse нет
- Значение по умолчанию: `null` — подстановка не выполняется
- Эффективное значение: не переопределяется; при выключенном `--enable-priority-scheduling` значение полностью игнорируется, о чем печатается предупреждение
- Где объявлен: `ServerArgs.default_priority_value`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `TokenizerManager` — до отправки запроса в scheduler

## Что меняет в движке

Подстановка выполняется один раз, в `TokenizerManager._set_default_priority`:

```python
if self.enable_priority_scheduling and obj.priority is None and self.default_priority_value is not None:
    obj.priority = self.default_priority_value
```

Дальше значение живет как обычный приоритет: участвует в сортировке `waiting_queue`, в решении о вытеснении (`PrefillAdder.preempt_to_schedule`), в выборе жертвы при переполненной очереди (`--max-queued-requests`) и попадает меткой `priority` в метрики токенайзера.

Если аргумент не задан, `Scheduler._set_or_validate_priority` подставляет крайнее значение шкалы: `-sys.maxsize - 1` в обычном режиме и `sys.maxsize` при `--schedule-low-priority-values-first`. В обоих случаях это **наихудший** приоритет — такой запрос никогда никого не вытеснит и первым покинет переполненную очередь. Метрики при этом видят строку `None`, а не число, потому что подстановка происходит в scheduler'е уже после того, как токенайзер сформировал метки.

## Значения и формат

- Целое число. Шкала произвольная: значение осмысленно только относительно приоритетов, которые проставляют клиенты.
- Отдельного «нейтрального» значения нет — выберите середину диапазона, который используете (типично `0` при шкале `-100…100` или `100` при шкале `0…1000`).
- Помните про `--priority-scheduling-preemption-threshold` (по умолчанию 10): чтобы клиентский приоритет вытеснял «обычный» трафик, разница с базовым значением должна строго превышать порог.
- Задавать значение без `--enable-priority-scheduling` бессмысленно: движок напечатает `--default-priority-value has no effect without --enable-priority-scheduling` и продолжит старт.

## Когда использовать

- Всегда, когда включено приоритетное планирование: это единственный способ дать неразмеченному трафику определенное место на шкале.
- Когда часть клиентов размечает запросы, а часть — нет, и «неразмеченные» не должны быть аутсайдерами.
- Когда нужны осмысленные метрики: без базового значения гистограммы разъезжаются между числовыми метками и строкой `None`.
- Не нужен, если весь трафик обязательно размечен на стороне клиента, — но тогда проще все равно задать значение как страховку от забытого поля.

## Влияние на производительность и память

- На память и на скорость не влияет: это подстановка одного целого числа в объект запроса.
- Косвенное влияние — через долю вытеснений: слишком низкое базовое значение делает обычный трафик постоянной жертвой, и throughput падает из-за переработки вытесненных запросов.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: без него значение не читается.
- `--schedule-low-priority-values-first`: переворачивает смысл «выше/ниже» относительно базового значения.
- `--priority-scheduling-preemption-threshold`: определяет, насколько клиентский приоритет должен отличаться от базового, чтобы вытеснять.
- `--disable-priority-preemption`: оставляет базовому значению только роль ключа сортировки очереди.
- `--max-queued-requests`: при переполнении очереди базовое значение решает, чей запрос будет отброшен.
- `--abort-on-priority-when-disabled`: сценарий-антипод — сервер без приоритетов, отвергающий запросы с приоритетом.

## Типовые проблемы и диагностика

- Предупреждение `--default-priority-value is not set while --enable-priority-scheduling is enabled. Requests without explicit priority will have priority=None, resulting in priority='None' string labels in Prometheus metrics.` — задайте значение.
- Предупреждение `--default-priority-value has no effect without --enable-priority-scheduling` — вы задали базовый приоритет, но забыли головной флаг.
- Неразмеченные запросы никогда не обслуживаются под нагрузкой — базовое значение слишком низкое относительно того, что шлют клиенты.
- Клиентский приоритет не дает эффекта — разница с базовым значением не превышает порог вытеснения.
- Принятое значение видно в дампе `server_args=`; фактические приоритеты живых запросов — в метке `priority` метрик токенайзера при включенном `--enable-metrics`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --default-priority-value 0
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-low-priority-values-first --default-priority-value 100 --priority-scheduling-preemption-threshold 10
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
