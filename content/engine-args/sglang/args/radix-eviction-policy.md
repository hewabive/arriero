---
schema: 1
engine: sglang
primaryName: "--radix-eviction-policy"
title: "--radix-eviction-policy"
summary: Порядок, в котором из дерева префиксов вытесняются листья при нехватке слотов KV. Меняет только приоритет жертв, не объем памяти и не сам факт вытеснения.
group: memory
related:
  - --disable-radix-cache
  - --enable-priority-scheduling
  - --enable-hierarchical-cache
  - --enable-session-radix-cache
  - --mem-fraction-static
---

# --radix-eviction-policy

## Кратко

Когда в KV-пуле кончаются свободные слоты, дерево префиксов выбирает листья на вытеснение. `--radix-eviction-policy` задает функцию приоритета для этого выбора: по времени последнего доступа (`lru`), по числу попаданий (`lfu`), по сегментам «испытательный/защищенный» (`slru`) или по приоритету запроса (`priority`). Аргумент не влияет ни на размер пула, ни на момент запуска вытеснения — только на то, кого выселят первым. При выключенном дереве префиксов (`--disable-radix-cache`) значение не используется.

## Оригинальная справка

```text
The eviction policy of radix trees. 'lru' stands for Least Recently Used, 'lfu' stands for Least Frequently Used, 'slru' stands for Segmented Least Recently Used, and 'priority' evicts lower-priority requests first.
```

## Паспорт аргумента

- Флаги: `--radix-eviction-policy`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `lru`, `lfu`, `slru`, `priority`. Список — константа `RADIX_EVICTION_POLICY_CHOICES` в `sglang/python/sglang/srt/server_args.py`; функция `add_radix_eviction_policy_choices` позволяет сторонним пакетам его расширить, поэтому итоговый набор проверяйте по `--help` установленной сборки
- Значение по умолчанию: `lru`
- Эффективное значение: не переопределяется в `__post_init__`
- Где объявлен: `ServerArgs.radix_eviction_policy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор дерева кеша (через `CacheInitParams.eviction_policy`) → каждый проход вытеснения

## Что меняет в движке

Значение приводится к нижнему регистру и превращается в объект стратегии функцией `get_eviction_strategy` (`sglang/python/sglang/srt/mem_cache/utils.py`). Стратегия — это одна функция `get_priority(node)`, по которой строится min-heap из листьев дерева; вытесняется узел с наименьшим значением (`sglang/python/sglang/srt/mem_cache/evict_policy.py`):

- `lru` → `node.last_access_time`;
- `lfu` → кортеж `(node.hit_count, node.last_access_time)`, то есть первично — по числу попаданий, при равенстве — по времени;
- `slru` → `(is_protected, node.last_access_time)`, где `is_protected = 1` при `hit_count >= 2`. Узлы «испытательного» сегмента всегда вытесняются раньше защищенных;
- `priority` → `(node.priority, node.last_access_time)`.

`node.priority` берется из поля `priority` самого запроса (`getattr(req, "priority", 0) or 0`), то есть `None` превращается в `0`. Приоритет распространяется по пути вставки через `max`, корень инициализируется минимально возможным значением, а при расщеплении узла новый узел наследует приоритет ребенка. Это отдельный от планировщика механизм: `--enable-priority-scheduling` управляет порядком в очереди ожидания, а здесь то же поле запроса используется для выбора жертвы в дереве.

Фабрика стратегий знает больше имен, чем принимает CLI (`fifo`, `mru`, `filo`), но argparse ограничен четырьмя значениями из `choices`.

Та же стратегия используется в HiCache: `HiRadixCache._make_eviction_heap` строит кучу по ней и для `write_through`-пути, и для `write_back`-пути вытеснения.

## Значения и формат

- `lru` (по умолчанию) — классика, хорошо работает на диалогах и агентных цепочках, где горячий префикс постоянно переиспользуется.
- `lfu` — защищает часто используемые узлы независимо от давности. Риск: «залипание» старых, но когда-то популярных префиксов, поскольку счетчик попаданий не затухает.
- `slru` — компромисс: узел попадает в защищенный сегмент после второго попадания. Порог (2) захардкожен в `SLRUStrategy` и через CLI не настраивается.
- `priority` — вытесняет сначала префиксы низкоприоритетных запросов. Имеет смысл только если клиенты реально передают `priority` в запросах; иначе у всех узлов приоритет 0 и политика вырождается в `lru`.
- Значение вне списка отвергает argparse.

## Когда использовать

- Оставляйте `lru`, если нет измеренной проблемы с hit rate: это дефолт и разумная база.
- `slru` — когда в трафике много одноразовых длинных промптов, вытесняющих горячий системный префикс: «испытательный» сегмент их отфильтрует.
- `lfu` — когда набор горячих префиксов узкий и стабильный (один системный промпт на всех).
- `priority` — только в связке с осмысленным `priority` в запросах, обычно вместе с `--enable-priority-scheduling`, чтобы приоритеты влияли и на очередь, и на кеш согласованно.
- Не ждите от аргумента экономии памяти: он не меняет ни размер пула, ни порог запуска вытеснения.

## Влияние на производительность и память

- На VRAM и RAM не влияет: размер KV-пула и host-пула задают другие аргументы.
- Влияет на hit rate дерева при памяти под давлением, а значит на TTFT и throughput. Если пул не переполняется, аргумент не даст никакого эффекта вообще.
- Вычислительная стоимость всех четырех стратегий одинакова по порядку: построение кучи по листьям на каждый проход вытеснения.
- Косвенно затрагивает L2 при `--enable-hierarchical-cache`: та же стратегия определяет, какие узлы первыми уедут на хост или будут отброшены.

## Взаимодействие с другими аргументами

- `--disable-radix-cache`: дерева нет, значение не используется.
- `--enable-priority-scheduling`: не обязателен для политики `priority`, но именно он делает поле `priority` осмысленной частью контракта запроса; без него приоритеты влияют только на вытеснение.
- `--enable-hierarchical-cache`: стратегия применяется и к вытеснению из L1 в L2.
- `--enable-session-radix-cache`: добавляет более грубый уровень сортировки — сначала вытесняются узлы без ссылок сессий, и только внутри этих групп работает выбранная политика.
- `--mem-fraction-static`, `--max-total-tokens`, `--context-length`: определяют, как часто вообще случается вытеснение, то есть насколько заметен эффект аргумента.

## Типовые проблемы и диагностика

- Смена политики ничего не изменила — скорее всего, вытеснение не происходит: пул не заполняется. Проверьте загрузку KV-пула и `cached_tokens` при `--enable-cache-report`.
- Политика `priority` ведет себя как `lru` — клиенты не передают `priority` в запросах, все узлы имеют приоритет 0.
- Горячий системный промпт регулярно теряется под потоком длинных уникальных запросов — попробуйте `slru`.
- `ValueError: Unknown eviction policy: <x>. Supported policies: 'lru', 'lfu', 'fifo', 'mru', 'filo', 'priority', 'slru'.` — значение пришло не из CLI (например, из YAML-конфига) и не входит в набор фабрики.
- Принятое значение видно в дампе `server_args=` при старте; тип созданного дерева — в строке «Tree cache initialized: source=… impl=…».

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy slru
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy priority --enable-priority-scheduling --schedule-policy fcfs
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/evict_policy.py`
- `sglang/python/sglang/srt/mem_cache/utils.py`
- `sglang/python/sglang/srt/mem_cache/radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
