---
schema: 1
engine: sglang
primaryName: "--schedule-policy"
title: "--schedule-policy"
summary: Порядок, в котором ожидающие запросы разбираются из очереди при сборке prefill-батча. Влияет только на очередность, не на объем допущенной работы; значение `priority` из списка `choices` рабочим не является.
group: schedule
related:
  - --schedule-conservativeness
  - --enable-priority-scheduling
  - --schedule-low-priority-values-first
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --max-running-requests
  - --chunked-prefill-size
  - --retraction-policy
---

# --schedule-policy

## Кратко

На каждом проходе сборки prefill-батча планировщик сначала сортирует всю очередь ожидания, а потом идет по ней сверху вниз и добавляет запросы, пока не кончится бюджет. `--schedule-policy` определяет именно эту сортировку. Он не меняет ни размер батча, ни объем KV-памяти — только то, кто попадет в батч первым и, как следствие, сколько префиксов удастся переиспользовать.

## Оригинальная справка

```text
The scheduling policy of the requests.
```

## Паспорт аргумента

- Флаги: `--schedule-policy`
- Группа: `schedule`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `lpm`, `random`, `fcfs`, `dfs-weight`, `lof`, `priority`, `routing-key`. Значение `priority` argparse примет, но реализации у него нет (см. «Типовые проблемы»)
- Значение по умолчанию: `fcfs`
- Эффективное значение: значение из CLI не переписывается, но **активная** политика может отличаться от заданной на каждом проходе: `SchedulePolicy._validate_and_adjust_policy` понижает кеш-зависимые политики до `fcfs`, если radix cache отключен, а `_determine_active_policy` понижает `lpm` до `fcfs`, пока в очереди больше 128 запросов
- Где объявлен: `ServerArgs.schedule_policy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание `SchedulePolicy` при инициализации планировщика → вызов `calc_priority` в начале каждой сборки prefill-батча

## Что меняет в движке

Как формируется prefill-батч (`Scheduler._get_new_batch_prefill_raw`, `sglang/python/sglang/srt/managers/scheduler.py`):

1. проверяются глобальные стопы (батч уже полон, очередь пуста, нет свободных слотов);
2. `self.policy.calc_priority(self.waiting_queue, running_batch)` — **сортировка всей очереди на месте**;
3. создается `PrefillAdder` с бюджетами: `rem_input_tokens = --max-prefill-tokens`, `rem_chunk_tokens = --chunked-prefill-size`, `rem_total_tokens` — свободные плюс вытесняемые токены KV-пула минус резерв под уже запущенные запросы;
4. очередь обходится по порядку, каждый запрос проходит `adder.add_one_req(...)`; первый же возврат, отличный от `CONTINUE`, обрывает обход.

Политика влияет только на шаг 2. Реализации (`sglang/python/sglang/srt/managers/schedule_policy.py`):

- `fcfs` — очередь не сортируется вовсе (при `--enable-priority-scheduling` — сортируется по `(priority, время постановки в очередь)`);
- `lof` (longest output first) — по убыванию `sampling_params.max_new_tokens`;
- `random` — `random.shuffle`;
- `lpm` (longest prefix match) — для каждого запроса считается совпадение с radix cache, сортировка по убыванию длины совпавшего префикса; дополнительно работает «in-batch prefix caching»: запросы, у которых совпадение с деревом короче 32 токенов, но которые делят длинный общий префикс между собой, временно опускаются в конец, чтобы сначала прошел один из них и наполнил кеш (пороги настраиваются переменными окружения `IN_BATCH_PREFIX_CACHING_CHECK_THRESHOLD` и `IN_BATCH_PREFIX_CACHING_DEPRIORITIZE_THRESHOLD`);
- `dfs-weight` — обход дерева префиксов в глубину с приоритетом более «тяжелых» поддеревьев; очередь пересобирается в порядке обхода;
- `routing-key` — вперед идут запросы, чей заголовок `x-smg-routing-key` уже встречается среди запущенных; ключи сортируются по убыванию частоты в running-батче, запросы без ключа уходят в конец.

`lpm` и `dfs-weight` относятся к кеш-зависимым (`CacheAwarePolicy`) и требуют работающего дерева префиксов: при `--disable-radix-cache` обе молча превращаются в `fcfs` еще на этапе конструктора.

## Значения и формат

- `fcfs` (по умолчанию) — самый дешевый вариант: сортировки нет вообще.
- `lpm` — единственная политика, которая целенаправленно повышает hit rate префиксного кеша; платит полным проходом по очереди с матчингом по дереву на каждой итерации планировщика. Автоматически отключается, пока `len(waiting_queue) > 128`, — то есть под высокой очередью вы фактически получаете `fcfs`.
- `dfs-weight` — вариант для сильно ветвящихся деревьев (много запросов от общего корня); дороже `lpm` по обходу.
- `lof` — «длинные генерации вперед»; полезно, когда важна суммарная утилизация, а не справедливость.
- `random` — только для нагрузочных тестов и воспроизведения патологических порядков.
- `routing-key` — имеет смысл только за SGLang Model Gateway, который проставляет `x-smg-routing-key`; без заголовка политика вырождается в «ничего не делать».
- `priority` — есть в `choices`, но не реализована; см. «Типовые проблемы».
- Значение вне списка отвергает argparse.

## Когда использовать

- Много запросов с общим длинным системным промптом или общим документом, а `#cached-token` в логе мал — `--schedule-policy lpm`. Апстрим-документация по тюнингу рекомендует ровно этот случай.
- Очередь стабильно превышает пару сотен запросов — от `lpm` можно не ждать эффекта: он отключается по порогу 128.
- Включено `--enable-priority-scheduling` — выбор сужен до `fcfs` и `lof` жестким assert'ом; сортировка по приоритету добавляется поверх выбранной политики.
- Не меняйте политику, чтобы «уменьшить retraction» — за это отвечает `--schedule-conservativeness`, а не порядок очереди.

## Влияние на производительность и память

- На память не влияет: политика меняет только порядок разбора очереди, бюджеты `PrefillAdder` считаются одинаково.
- CPU-издержки планировщика растут в ряду `fcfs` < `lof` ≈ `random` ≈ `routing-key` < `lpm` < `dfs-weight`. На длинной очереди это заметная доля времени scheduler-процесса, поэтому у `lpm` и стоит защитный порог 128.
- Throughput выигрывает от `lpm` косвенно — через рост доли переиспользованных токенов, то есть за счет сокращения prefill-работы.
- TTFT при `lof` и `lpm` становится менее предсказуемым: запрос может ждать дольше, если ему «не повезло» с длиной префикса или генерации.

## Взаимодействие с другими аргументами

- `--enable-priority-scheduling`: требует `fcfs` или `lof`; иначе старт падает с сообщением `To use priority scheduling, schedule_policy must be 'fcfs' or 'lof'`.
- `--schedule-low-priority-values-first`: задает направление сортировки по приоритету внутри `fcfs`/`lof`.
- `--disable-radix-cache`: превращает `lpm`/`dfs-weight` в `fcfs`.
- `--enable-hierarchical-cache`: не меняет выбор политики, но `lpm` учитывает и подгружаемые с хоста префиксы, так что эффект от него на HiCache обычно выше.
- `--max-running-requests`, `--chunked-prefill-size`: ограничивают, сколько запросов из отсортированной очереди реально войдет в батч.
- `--retraction-policy`: обратная сторона — порядок, в котором запросы **выкидываются** из decode-батча при нехватке KV.

## Типовые проблемы и диагностика

- `ValueError: Unknown schedule_policy: policy='priority'` при старте. Значение `priority` присутствует в `choices` (`ServerArgs.schedule_policy`), но не соответствует ни одному варианту `CacheAwarePolicy`/`CacheAgnosticPolicy` в `schedule_policy.py`, поэтому конструктор `SchedulePolicy` всегда падает. Для приоритетов используйте `--enable-priority-scheduling` вместе с `--schedule-policy fcfs` или `lof`.
- `lpm` не дает эффекта: посмотрите `#queue-req` в строке `Prefill batch, …, #queue-req: …` — при значении больше 128 политика на этом проходе понижена до `fcfs`. Второй вариант — `--disable-radix-cache`, тогда понижение постоянное.
- `routing-key` ведет себя как `fcfs` — клиент не шлет заголовок `x-smg-routing-key`. Подробный разбор порядка включается переменной окружения `SGLANG_ROUTING_KEY_POLICY_DEBUG_LOG=1`.
- Проверить принятое значение: дамп `server_args=` при старте.
- Эффект политики измеряется долей `#cached-token` от `#new-token` в строках `Prefill batch` и метриками кеша при `--enable-metrics`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --schedule-policy lpm --chunked-prefill-size 8192
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --schedule-policy lof --enable-priority-scheduling --default-priority-value 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
