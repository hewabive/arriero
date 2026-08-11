---
schema: 1
engine: sglang
primaryName: "--abort-on-priority-when-disabled"
title: "--abort-on-priority-when-disabled"
summary: На сервере без приоритетного планирования обрывает запросы, которые все-таки прислали поле `priority`, с HTTP 503 вместо молчаливого игнорирования.
group: schedule
related:
  - --enable-priority-scheduling
  - --default-priority-value
  - --disable-priority-preemption
  - --max-queued-requests
---

# --abort-on-priority-when-disabled

## Кратко

Обычно сервер, запущенный без `--enable-priority-scheduling`, просто игнорирует поле `priority` в теле запроса — клиент получает нормальный ответ и не узнает, что его приоритет никого не интересовал. `--abort-on-priority-when-disabled` меняет молчание на явный отказ: такой запрос обрывается с HTTP 503 и сообщением, что приоритеты на этом сервере отключены. Это диагностический флаг для парка серверов, где часть инстансов приоритеты поддерживает, а часть — нет.

## Оригинальная справка

```text
If set, abort requests that specify a priority when priority scheduling is disabled.
```

## Паспорт аргумента

- Флаги: `--abort-on-priority-when-disabled`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false` — поле `priority` молча игнорируется
- Эффективное значение: не переопределяется; при включенном `--enable-priority-scheduling` ветка недостижима, и флаг ни на что не влияет (предупреждения при этом не печатается)
- Где объявлен: `ServerArgs.abort_on_priority_when_disabled`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `Scheduler._set_or_validate_priority` — на каждом входящем запросе, до постановки в очередь

## Что меняет в движке

Проверка выполняется в `_set_or_validate_priority`, во второй ветке того же условия, где при включенных приоритетах подставляется значение по умолчанию:

```python
elif (not self.enable_priority_scheduling
      and req.priority is not None
      and self.abort_on_priority_when_disabled):
    ...  # AbortReq, HTTPStatus.SERVICE_UNAVAILABLE
```

Клиент получает ответ со статусом 503 и текстом `Using priority is disabled for this server. Please send a new request without a priority.` Запрос помечается aborted в трассировке и в очередь не попадает вовсе.

Условие срабатывания — именно `req.priority is not None`. Значение `0`, присланное явно, тоже считается заданным приоритетом и приводит к отказу.

Требуемая комбинация всего семейства приоритетов описана в документе `--enable-priority-scheduling`; этот флаг — единственный из семейства, который осмысленно задавать **без** головного флага.

## Значения и формат

- Флаг без значения. «Не задан» — запросы с приоритетом обслуживаются как обычные.
- С головным флагом `--enable-priority-scheduling` этот флаг не конфликтует и не отвергается, но и не делает ничего: ветка проверяет `not self.enable_priority_scheduling`.
- Проверяется наличие поля, а не его величина; списочная форма (`priority` в батч-запросе) обрабатывается по тем же правилам, что и остальные поля запроса.

## Когда использовать

- В парке из нескольких инстансов, где часть запущена с приоритетами: явный 503 быстрее выявляет неверную маршрутизацию, чем «почему-то не работает приоритет».
- На этапе внедрения приоритетов, чтобы клиенты не начали полагаться на поле, которое сервер не читает.
- В arriero — когда один и тот же публичный модельный id может маршрутизироваться на разные targets: без флага поведение зависит от того, куда попал запрос, что маскирует ошибку конфигурации.
- Не включайте на общедоступном сервере с разнородными клиентами: любой клиент, отправляющий `priority` «на всякий случай», будет получать 503 вместо ответа.

## Влияние на производительность и память

- На память не влияет. На скорость влияет незначимо: одно сравнение на запрос до постановки в очередь.
- Косвенный эффект — доля 503 в ответах, если клиенты шлют `priority` без согласования с конфигурацией сервера.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: при нем флаг мертв. Осмысленная пара — «этот флаг без головного».
- `--default-priority-value`, `--disable-priority-preemption`: относятся к включенным приоритетам и с этим флагом не пересекаются; заданные без головного флага, они печатают собственные предупреждения.
- `--max-queued-requests`: тоже отвечает 503, но с другим текстом (`The request queue is full.`) — по тексту сообщения эти два случая и различаются.

## Типовые проблемы и диагностика

- Клиенты получают 503 `Using priority is disabled for this server. Please send a new request without a priority.` — либо уберите поле `priority` на стороне клиента, либо включите `--enable-priority-scheduling`, либо снимите этот флаг.
- Флаг задан, но отказов нет — проверьте, не запущен ли сервер с `--enable-priority-scheduling`; в этом случае предупреждения не будет, единственный источник истины — дамп `server_args=` при старте.
- Отказы приходят на запросах с `priority: 0` — так и задумано, проверяется наличие поля.
- Отличить этот отказ от переполнения очереди можно только по тексту сообщения: статус у обоих 503.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --abort-on-priority-when-disabled
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --abort-on-priority-when-disabled --max-queued-requests 256
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
