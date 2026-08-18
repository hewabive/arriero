---
schema: 1
engine: sglang
primaryName: "--retraction-policy"
title: "--retraction-policy"
summary: Порядок, в котором запущенные запросы выбрасываются из decode-батча, когда KV-пул переполнен. `length` жертвует «длинный вход, короткий выход», `priority` — низкоприоритетными и требует включенного priority scheduling.
group: schedule
related:
  - --enable-priority-scheduling
  - --schedule-low-priority-values-first
  - --schedule-conservativeness
  - --priority-scheduling-preemption-threshold
  - --radix-eviction-policy
  - --max-running-requests
  - --mem-fraction-static
---

# --retraction-policy

## Кратко

Retraction — аварийный механизм decode-цикла: если для следующего шага генерации не хватает места в KV-пуле, планировщик снимает часть запущенных запросов, освобождает их KV и возвращает их в очередь ожидания. `--retraction-policy` задает только порядок жертв. Сам факт retraction им не предотвращается — для этого есть `--schedule-conservativeness` и размер пула.

## Оригинальная справка

```text
The decode retraction policy to use when the KV cache is full. 'length' preserves the existing behavior and retracts short-output, long-input requests first. 'priority' retracts lower-priority requests first, using the same priority direction as priority scheduling.
```

## Паспорт аргумента

- Флаги: `--retraction-policy`
- Группа: `schedule`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `length`, `priority`
- Значение по умолчанию: `length`
- Эффективное значение: не переопределяется; `priority` без `--enable-priority-scheduling` не подставляется молча, а роняет старт с `ValueError`
- Где объявлен: `ServerArgs.retraction_policy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: каждый вызов `ScheduleBatch.retract_decode` из `Scheduler.update_running_batch`, то есть только в момент нехватки KV на decode-шаге

## Что меняет в движке

Триггер (`Scheduler.update_running_batch`, `sglang/python/sglang/srt/managers/scheduler.py`): перед каждым decode-шагом вызывается `batch.check_decode_mem()`. Она считает, сколько токенов нужно на следующий шаг, пытается освободить их вытеснением из radix cache (`evict_from_tree_cache`) и возвращает, хватает ли места. Если нет — запускается `retract_decode`.

Сам цикл (`ScheduleBatch.retract_decode`, `sglang/python/sglang/srt/managers/schedule_batch.py`):

1. `_get_decode_retraction_order` строит список индексов «от наиболее желательного к наименее желательному для сохранения»;
2. цикл снимает запросы **с конца** этого списка, освобождая их KV немедленно и не вставляя в дерево кеша, пока `check_decode_mem` не станет истинной;
3. минимум один запрос всегда остается; если и он не помещается, он аварийно завершается с `Out of memory even after retracting all other requests in the decode batch` и HTTP 500;
4. снятые запросы возвращаются в очередь ожидания через `_add_request_to_queue(req, is_retracted=True)` и позже пере-prefill'ятся (с учетом того, что часть их префикса могла остаться в кеше);
5. `new_token_ratio` заменяется на оценку по факту — сервер сразу становится консервативнее.

Ключи сортировки:

- `length`: `(len(output_ids), -len(origin_input_ids))`, сортировка по убыванию. Последними в списке (то есть первыми жертвами) оказываются запросы с наименьшим числом уже сгенерированных токенов и, при равенстве, с наибольшим входом. Логика простая: терять дешевле того, кто меньше всего успел насчитать, а длинный вход при пере-prefill'е с большой вероятностью попадет в radix cache;
- `priority`: `(priority * (-priority_sign), len(output_ids), -len(origin_input_ids))`, где `priority_sign = 1` при `--schedule-low-priority-values-first` и `-1` иначе. Приоритет — главный ключ, длина — вторичный. Запросы без приоритета получают крайнее значение (`sys.maxsize` либо `-sys.maxsize - 1`) и оказываются в самом низу, то есть выбрасываются первыми.

## Значения и формат

- `length` (по умолчанию) — не требует ничего дополнительно, работает всегда.
- `priority` — требует `--enable-priority-scheduling`; направление приоритета берется из `--schedule-low-priority-values-first` и совпадает с направлением, используемым при постановке в очередь.
- Значение вне списка отвергает argparse.
- Аргумент не имеет «выключенного» состояния: retraction произойдет в любом случае, вопрос только в порядке.

## Когда использовать

- `priority` — когда у трафика есть явные классы обслуживания и вы уже включили `--enable-priority-scheduling`: тогда под давлением памяти первыми пострадают фоновые задачи, а не интерактивные.
- `length` — во всех остальных случаях, и особенно если radix cache включен: жертва с длинным входом восстанавливается дешевле.
- Не выбирайте `priority` как способ «защитить важные запросы» без настройки самих приоритетов: запросы, у которых приоритет не проставлен (нет `--default-priority-value` и клиент его не шлет), станут первыми жертвами.
- Не используйте аргумент как средство борьбы с частым retraction — это симптом нехватки бюджета.

## Влияние на производительность и память

- Прямого влияния на объем памяти нет: количество освобожденных токенов определяется тем, сколько нужно для следующего decode-шага, а не политикой.
- Косвенно `length` дешевле по суммарной работе: он жертвует запросами, у которых меньше всего потерянных вычислений, и предпочитает те, чей вход лучше восстановится из префиксного кеша.
- `priority` может стоить дороже по throughput — жертвой становится не самый дешевый, а самый низкоприоритетный запрос, независимо от того, сколько он уже насчитал.
- На latency высокоприоритетного трафика `priority` влияет положительно, на хвостовую latency низкоприоритетного — резко отрицательно: он может выбрасываться повторно.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: обязателен для `priority`, иначе `ValueError: --retraction-policy priority requires --enable-priority-scheduling`.
- `--schedule-low-priority-values-first`: задает направление и для очереди, и для retraction — они всегда согласованы.
- `--priority-scheduling-preemption-threshold`: другой, независимый механизм — вытеснение при **допуске** нового запроса. Retraction срабатывает по памяти в decode, preemption — по приоритету в prefill.
- `--schedule-conservativeness`: единственная ручка, которая реально меняет частоту retraction.
- `--radix-eviction-policy`: вытеснение из дерева префиксов происходит **до** retraction (внутри `check_decode_mem`); при удачной настройке кеша до retraction дело может не дойти.
- `--disaggregation-decode-retraction-backup`: на PD decode-узле KV снятого запроса не пропадает, а сохраняется в CPU-tensor'ы или зарезервированный HiCache-пул и восстанавливается при повторном допуске — политика по-прежнему выбирает только жертв.
- `--mem-fraction-static`, `--max-running-requests`: определяют, сколько запросов вообще может ужиться в пуле.

## Типовые проблемы и диагностика

- `KV cache pool is full. Retract requests. #retracted_reqs: 2, #new_tokens_gained: …, #new_token_ratio: 0.6912 -> 0.8140` — retraction случился; число снятых запросов и объем освобожденных токенов в той же строке.
- `--retraction-policy priority` не влияет на выбор жертв: убедитесь, что запросы действительно несут приоритет. Без `--default-priority-value` и без явного поля в запросе все они получают одно и то же крайнее значение, и порядок вырождается в вторичный ключ по длине.
- Аборты с `Out of memory even after retracting all other requests in the decode batch` — пул не вмещает даже один запрос; политика тут ни при чем, смотрите `--mem-fraction-static`, `--context-length` и `--max-total-tokens`.
- Счетчики снятых запросов и потерянных токенов доступны как метрики при `--enable-metrics` (`increment_retracted_reqs`: число запросов, входных и выходных токенов).
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --retraction-policy length --schedule-conservativeness 1.3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-priority-scheduling --schedule-policy fcfs --default-priority-value 0 --retraction-policy priority
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/new_token_ratio_tracker.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
