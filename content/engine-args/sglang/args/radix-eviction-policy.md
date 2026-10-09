---
schema: 1
engine: sglang
primaryName: "--radix-eviction-policy"
title: "--radix-eviction-policy"
summary: Порядок, в котором из дерева префиксов вытесняются листья при нехватке слотов KV. Меняет только приоритет жертв, не объем памяти и не сам факт вытеснения.
group: memory
related:
  - --radix-eviction-policy-config
  - --disable-radix-cache
  - --enable-priority-scheduling
  - --enable-hierarchical-cache
  - --enable-session-radix-cache
  - --mem-fraction-static
---

# --radix-eviction-policy

## Кратко

Когда в KV-пуле кончаются свободные слоты, дерево префиксов выбирает листья на вытеснение. `--radix-eviction-policy` задает функцию приоритета для этого выбора: по времени последнего доступа (`lru`), по числу попаданий (`lfu`), по сегментам «испытательный/защищенный» (`slru`), по приоритету запроса (`priority`) или по тому, нужна ли эта часть хвоста диалога для TTFT следующего хода (`tlru`). Аргумент не влияет ни на размер пула, ни на момент запуска вытеснения — только на то, кого выселят первым. При выключенном дереве префиксов (`--disable-radix-cache`) значение не используется.

## Оригинальная справка

```text
The eviction policy of radix trees. 'lru' stands for Least Recently Used, 'lfu' stands for Least Frequently Used, 'slru' stands for Segmented Least Recently Used, 'priority' evicts lower-priority requests first, and 'tlru' stands for Tail-Optimized LRU (arXiv:2510.15152), which evicts the part of a conversation that cannot affect tail TTFT before falling back to LRU. See https://docs.sglang.io/docs/advanced_features/radix_eviction_policy for what each policy optimizes for.
```

## Паспорт аргумента

- Флаги: `--radix-eviction-policy`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `lru`, `lfu`, `slru`, `priority`, `tlru`. Список — константа `RADIX_EVICTION_POLICY_CHOICES` в `sglang/python/sglang/srt/arg_groups/choices.py`; функция `add_radix_eviction_policy_choices` позволяет сторонним пакетам его расширить, поэтому итоговый набор проверяйте по `--help` установленной сборки
- Значение по умолчанию: `lru`
- Эффективное значение: не переопределяется в `__post_init__`; для `tlru` `handle_cache_compatibility` там же проверяет параметры из `--radix-eviction-policy-config`
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.radix_eviction_policy`
- Статус: обычный
- Этап применения: `__post_init__` (проверка параметров `tlru`) → конструктор дерева кеша (через `CacheInitParams.eviction_policy` и `eviction_policy_config`; для `tlru` — проверка, что построен `UnifiedRadixCache`) → каждый проход вытеснения

## Что меняет в движке

Значение приводится к нижнему регистру и превращается в объект стратегии функцией `get_eviction_strategy` (`sglang/python/sglang/srt/mem_cache/utils.py`); параметры из `--radix-eviction-policy-config` передаются в ее конструктор как keyword-аргументы. Стратегия — это одна функция `get_priority(node)`, по которой ранжируются вытесняемые листья дерева; вытесняется узел с наименьшим значением (`sglang/python/sglang/srt/mem_cache/evict_policy.py`). Дерево по умолчанию теперь — `UnifiedRadixCache` с Rust TreeCore (`SGLANG_UNIFIED_RADIX_TREE_CORE_BACKEND=rust`); Rust-ядро реализует те же политики нативно, получая имя политики и ее параметры, а Python-стратегия при этом создается для проверки параметров:

- `lru` → `node.last_access_time`;
- `lfu` → кортеж `(node.hit_count, node.last_access_time)`, то есть первично — по числу попаданий, при равенстве — по времени;
- `slru` → `(is_protected, node.last_access_time)`, где `is_protected = 1` при `hit_count >= protected_threshold` (по умолчанию 2, задается через `--radix-eviction-policy-config`). Узлы «испытательного» сегмента всегда вытесняются раньше защищенных;
- `priority` → `(node.priority, node.last_access_time)`;
- `tlru` → `(-1 if tel_safe else 0, node.last_access_time)`. Для каждой ветки дерево ведет высоту «высокой воды» `L` (максимальную длину диалога, достигнутую по этому пути) и длину закешированного префикса. Диалогу достаточно держать в кеше `L + next_prompt_estimate - threshold` токенов, чтобы следующий prefill уложился в `threshold` некешированных токенов; все сверх этого — «TEL-safe» и вытесняется первым, а когда такие узлы кончаются, вытеснение идет обычным LRU. Учет длин включается только при `tlru` и стоит O(узлов пути) на вставку.

`node.priority` берется из поля `priority` самого запроса (`getattr(req, "priority", 0) or 0`), то есть `None` превращается в `0`. Приоритет распространяется по пути вставки через `max`, корень инициализируется минимально возможным значением, а при расщеплении узла новый узел наследует приоритет ребенка. Это отдельный от планировщика механизм: `--enable-priority-scheduling` управляет порядком в очереди ожидания, а здесь то же поле запроса используется для выбора жертвы в дереве.

Фабрика стратегий знает больше имен, чем принимает CLI (`fifo`, `mru`, `filo`), но argparse ограничен пятью значениями из `choices`.

`tlru` работает только на `UnifiedRadixCache`: учет длин есть только у него. Если для модели выбрано другое дерево, при создании кеша — `ValueError: --radix-eviction-policy tlru requires UnifiedRadixCache, but tree_cache is <Class>…`, а не молчаливый откат к LRU. HiCache (`--enable-hierarchical-cache`) тоже идет через `UnifiedRadixCache`, отдельный `HiRadixCache` из кода удален, поэтому выбранная политика действует и на вытеснение из L1.

## Значения и формат

- `lru` (по умолчанию) — классика, хорошо работает на диалогах и агентных цепочках, где горячий префикс постоянно переиспользуется.
- `lfu` — защищает часто используемые узлы независимо от давности. Риск: «залипание» старых, но когда-то популярных префиксов, поскольку счетчик попаданий не затухает.
- `slru` — компромисс: узел попадает в защищенный сегмент после `protected_threshold` попаданий (по умолчанию 2; меняется через `--radix-eviction-policy-config '{"protected_threshold": 4}'`).
- `priority` — вытесняет сначала префиксы низкоприоритетных запросов. Имеет смысл только если клиенты реально передают `priority` в запросах; иначе у всех узлов приоритет 0 и политика вырождается в `lru`.
- `tlru` — для агентных и многоходовых диалогов, где важнее хвост TTFT, чем общий hit rate. Без параметров не стартует: при дефолтных `threshold = next_prompt_estimate = 0` проверка «threshold > next_prompt_estimate» не проходит. `threshold` и `next_prompt_estimate` задаются в токенах (в статье — в блоках, умножайте на `--page-size`).
- Значение вне списка отвергает argparse.

## Когда использовать

- Оставляйте `lru`, если нет измеренной проблемы с hit rate: это дефолт и разумная база.
- `slru` — когда в трафике много одноразовых длинных промптов, вытесняющих горячий системный префикс: «испытательный» сегмент их отфильтрует.
- `lfu` — когда набор горячих префиксов узкий и стабильный (один системный промпт на всех).
- `priority` — только в связке с осмысленным `priority` в запросах, обычно вместе с `--enable-priority-scheduling`, чтобы приоритеты влияли и на очередь, и на кеш согласованно.
- `tlru` — многоходовые агентные сессии с длинной историей и целевым TTFT: `threshold` подбирают как TTFT-бюджет, деленный на измеренное время prefill одного некешированного токена, `next_prompt_estimate` — как средний прирост промпта за ход.
- Не ждите от аргумента экономии памяти: он не меняет ни размер пула, ни порог запуска вытеснения.

## Влияние на производительность и память

- На VRAM и RAM не влияет: размер KV-пула и host-пула задают другие аргументы.
- Влияет на hit rate дерева при памяти под давлением, а значит на TTFT и throughput. Если пул не переполняется, аргумент не даст никакого эффекта вообще.
- Вычислительная стоимость стратегий одинакова по порядку: ранжирование листьев на каждый проход вытеснения. `tlru` добавляет проход по пути к корню при вставке, чтобы обновить длины ветки.
- Косвенно затрагивает L2 при `--enable-hierarchical-cache`: та же стратегия определяет, какие узлы первыми уедут на хост или будут отброшены.

## Взаимодействие с другими аргументами

- `--radix-eviction-policy-config`: параметры выбранной политики (`slru` — `protected_threshold`, `tlru` — `threshold` и `next_prompt_estimate`); неизвестный ключ — ошибка на старте.
- `--disable-radix-cache`: дерева нет, значение не используется.
- `--enable-priority-scheduling`: не обязателен для политики `priority`, но именно он делает поле `priority` осмысленной частью контракта запроса; без него приоритеты влияют только на вытеснение.
- `--enable-hierarchical-cache`: стратегия применяется и к вытеснению из L1 в L2.
- `--enable-session-radix-cache`: добавляет более грубый уровень сортировки — сначала вытесняются узлы без ссылок сессий, и только внутри этих групп работает выбранная политика. Сессионный кеш требует Python TreeCore — Rust-ядро в этом случае не используется.
- `--mem-fraction-static`, `--max-total-tokens`, `--context-length`: определяют, как часто вообще случается вытеснение, то есть насколько заметен эффект аргумента.

## Типовые проблемы и диагностика

- Смена политики ничего не изменила — скорее всего, вытеснение не происходит: пул не заполняется. Проверьте загрузку KV-пула и `cached_tokens` при `--enable-cache-report`.
- Политика `priority` ведет себя как `lru` — клиенты не передают `priority` в запросах, все узлы имеют приоритет 0.
- Горячий системный промпт регулярно теряется под потоком длинных уникальных запросов — попробуйте `slru`.
- `ValueError: Unknown eviction policy: <x>. Supported policies: 'lru', 'lfu', 'fifo', 'mru', 'filo', 'priority', 'slru', 'tlru'.` — значение пришло не из CLI (например, из YAML-конфига) и не входит в набор фабрики.
- `ValueError: --radix-eviction-policy tlru needs 'threshold' greater than 'next_prompt_estimate' in --radix-eviction-policy-config, got 0 <= 0…` — `tlru` задан без параметров; передайте их через `--radix-eviction-policy-config`.
- `ValueError: --radix-eviction-policy tlru requires UnifiedRadixCache, but tree_cache is …` — модель выбрала другое дерево; уберите `tlru` или опцию, которая выбрала другой кеш.
- Принятое значение видно в дампе `server_args=` при старте; тип созданного дерева — в строке «Tree cache initialized: source=… impl=…».

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy slru
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy priority --enable-priority-scheduling --schedule-policy fcfs
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy tlru --radix-eviction-policy-config '{"threshold": 4096, "next_prompt_estimate": 512}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/choices.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/mem_cache/evict_policy.py`
- `sglang/python/sglang/srt/mem_cache/utils.py`
- `sglang/python/sglang/srt/mem_cache/radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/unified_tree_core.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/tree_core_registry.py`
- `sglang/python/sglang/srt/mem_cache/rust_tree_core/adapter.py`
- `sglang/docs/docs/advanced_features/radix_eviction_policy.mdx`
- upstream PR #34012 «Add Agentic-Aware Tail-Optimized LRU eviction to the unified radix cache» (коммит `1a90ae6727` в checkout)
