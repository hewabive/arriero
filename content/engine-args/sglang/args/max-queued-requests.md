---
schema: 1
engine: sglang
primaryName: "--max-queued-requests"
title: "--max-queued-requests"
summary: Потолок длины очереди ожидания. При переполнении лишний запрос обрывается с HTTP 503 вместо неограниченного ожидания; игнорируется в любом режиме disaggregation.
group: schedule
related:
  - --max-running-requests
  - --enable-priority-scheduling
  - --schedule-low-priority-values-first
  - --disaggregation-mode
  - --schedule-policy
---

# --max-queued-requests

## Кратко

`--max-queued-requests` ограничивает `waiting_queue` — очередь запросов, принятых сервером, но еще не попавших в running batch. По умолчанию очередь не ограничена, и при перегрузке запросы копятся, пока клиенты не отвалятся по таймауту. С заданным значением сервер вместо этого отвечает быстрым отказом: `503` с сообщением `The request queue is full.` При включенном приоритетном планировании отбрасывается не обязательно новый запрос, а наименее приоритетный из очереди.

## Оригинальная справка

```text
The maximum number of queued requests. This option is ignored when using disaggregation-mode.
```

## Паспорт аргумента

- Флаги: `--max-queued-requests`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: положительное целое; проверок в argparse нет
- Значение по умолчанию: `null` — очередь не ограничена
- Эффективное значение: не переопределяется; значение доходит до scheduler'а без изменений, но не читается вовсе при `--disaggregation-mode` отличном от `null`
- Где объявлен: `ServerArgs.max_queued_requests`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `Scheduler._add_request_to_queue` — каждый входящий запрос

## Что меняет в движке

`_abort_on_queued_limit(recv_req)` вызывается перед постановкой запроса в очередь и только в режиме `DisaggregationMode.NULL`:

```python
if self.max_queued_requests is None or len(self.waiting_queue) + 1 <= self.max_queued_requests:
    return False
```

Дальше поведение зависит от приоритетного планирования:

- без него отбрасывается сам входящий запрос с сообщением `The request queue is full.`;
- с `--enable-priority-scheduling` scheduler находит в очереди наименее предпочтительный запрос (по приоритету, при равенстве — более поздний по времени постановки) и, если новый запрос строго лучше, выбрасывает из очереди старый с сообщением `The request is aborted by a higher priority request.`, а новый ставит на его место. При этом корректно освобождаются prefetch-события HiCache.

Отказ приходит клиенту как `AbortReq` со статусом `HTTPStatus.SERVICE_UNAVAILABLE` (503); запрос помечается aborted и в трассировке.

Для `--disaggregation-mode prefill`/`decode` вызов не выполняется вообще — запросы уходят в собственные очереди bootstrap/prealloc, и справка честно говорит, что опция игнорируется.

## Значения и формат

- Целое число запросов; суффиксы SI/IEC не поддерживаются.
- `null` (не задан) — без ограничения. Отдельного значения «безлимит» вроде `-1` нет.
- Проверка формулируется как `len(waiting_queue) + 1 <= max_queued_requests`, то есть значение — именно максимальная длина очереди, включая новый запрос.
- `0` argparse примет: тогда очередь запрещена целиком и все, что не попало в running batch, немедленно получает 503.

## Когда использовать

- Когда клиент лучше переживет быстрый 503 и ретрай, чем минуты ожидания: интерактивные фронтенды, шлюзы с собственным балансировщиком.
- Когда нужен явный сигнал перегрузки для внешнего автоскейлера или для маршрутизатора перед несколькими инстансами.
- Вместе с `--enable-priority-scheduling`, чтобы низкоприоритетный фон не занимал очередь и вытеснялся входящей интерактивной нагрузкой.
- Не нужен для оффлайн-батчинга: там глубокая очередь — это ровно то, что удерживает высокий `token usage`; апстрим считает здоровым `#queue-req` в диапазоне 100–2000.
- В arriero учитывайте, что перед SGLang стоит собственная очередь прокси (lease/domain-gate, `docs/RESOURCE_MANAGEMENT.md`): конкурирующие запросы там ждут, а не получают 503. Слишком маленький `--max-queued-requests` превратит это ожидание в ошибку у клиента.

## Влияние на производительность и память

- На память не влияет: ограничивается число объектов запросов в списке Python, а KV-слоты очередью не занимаются.
- На throughput влияет только косвенно — слишком маленькая очередь оставляет планировщик без кандидатов и роняет утилизацию.
- На latency влияет заменой «долгого ожидания» на «быстрый отказ»: p99 успешных ответов улучшается за счет доли ошибок.

## Взаимодействие с другими аргументами

- `--max-running-requests`: определяет, как быстро очередь рассасывается. Пара «маленький running + маленькая queue» дает высокий процент 503 под нагрузкой.
- `--enable-priority-scheduling` и `--schedule-low-priority-values-first`: включают режим вытеснения из очереди по приоритету вместо отказа входящему; направление сравнения задает второй флаг.
- `--disaggregation-mode`: любое значение кроме `null` полностью отключает механизм.
- `--schedule-policy`: определяет порядок разбора очереди, но не ее длину.

## Типовые проблемы и диагностика

- Клиенты получают 503 `The request queue is full.` — очередь достигла лимита. Либо поднимайте значение, либо увеличивайте пропускную способность (`--max-running-requests`, `--mem-fraction-static`).
- Клиенты получают 503 `The request is aborted by a higher priority request.` — работает приоритетное вытеснение из очереди; это ожидаемое поведение при включенном приоритетном планировании.
- 503 при пустом сервере — проверьте, не задан ли `0`.
- Ограничение не действует — убедитесь, что `--disaggregation-mode` не задан (или равен `null`).
- Текущую длину очереди показывает поле `#queue-req` в строках `Decode batch, …` и `Prefill batch, …`; принятое значение аргумента — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-queued-requests 256
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-running-requests 16 --max-queued-requests 64 --enable-priority-scheduling --default-priority-value 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
