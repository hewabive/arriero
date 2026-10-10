---
schema: 1
engine: sglang
primaryName: "--radix-eviction-policy-config"
title: "--radix-eviction-policy-config"
summary: Передаёт параметры выбранной политике вытеснения radix cache в виде JSON-объекта. Параметры принимают `slru` (`protected_threshold`) и `tlru` (`threshold`, `next_prompt_estimate`); для `tlru` они фактически обязательны.
group: memory
related:
  - --radix-eviction-policy
  - --disable-radix-cache
  - --page-size
---

# --radix-eviction-policy-config

## Кратко

Передаёт параметры выбранной политике вытеснения radix cache в виде JSON-объекта: ключи становятся keyword-аргументами конструктора стратегии. Параметры есть у двух политик — `slru` (порог перевода в защищённый сегмент) и `tlru` (TTFT-порог и ожидаемый прирост промпта за ход). `lru`, `lfu` и `priority` параметров не принимают, и любой ключ для них — ошибка запуска.

## Оригинальная справка

```text
Tuning parameters for --radix-eviction-policy, as a json object passed to the policy as keyword arguments. 'slru' takes protected_threshold (int, default 2), e.g. '{"protected_threshold": 4}'; 'tlru' takes threshold and next_prompt_estimate (ints, tokens), e.g. '{"threshold": 4096, "next_prompt_estimate": 512}'. An unrecognized key fails at startup, naming the key and the policy. See https://docs.sglang.io/docs/advanced_features/radix_eviction_policy#policy-parameters for the full parameter list.
```

## Паспорт аргумента

- Флаги: `--radix-eviction-policy-config`
- Группа: `memory`
- Тип значения: JSON-объект (`type_parser=json.loads`)
- Допустимые значения: ключи зависят от `--radix-eviction-policy`; `choices` нет
- Значение по умолчанию: `null` — стратегия создается с собственными дефолтами
- Эффективное значение: ни один шаг резолва его не декларирует; для `tlru` шаг `handle_cache_compatibility` (`arg_groups/kv_cache_hook.py`) проверяет `threshold` и `next_prompt_estimate`
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.radix_eviction_policy_config`
- Статус: обычный
- Этап применения: разбор CLI (`json.loads`) → `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_cache_compatibility` (проверка `tlru`) → `CacheInitParams.eviction_policy_config` в `kv_cache_builder` → конструктор стратегии в дереве кеша

## Что меняет в движке

`get_eviction_strategy(policy, config)` (`sglang/python/sglang/srt/mem_cache/utils.py`) вызывает фабрику политики как `factory(**config)`; пустой или отсутствующий объект означает `factory()` с дефолтами. Стратегию строит и Python-дерево (`radix_cache.py`, `unified_tree_core.py`), и Rust TreeCore (`rust_tree_core/adapter.py`) — последний создает Python-объект ради той же проверки ключей, а затем передает в нативное ядро `protected_threshold` или посчитанный бюджет `threshold - next_prompt_estimate`.

- `slru`: `protected_threshold` (int, по умолчанию 2) — число попаданий, после которого узел переходит в защищённый сегмент и вытесняется только после всех «испытательных».
- `tlru`: `threshold` — TTFT-порог в токенах: диалог держит в кеше столько истории, чтобы следующий prefill уложился в `threshold` некешированных токенов; `next_prompt_estimate` — ожидаемый прирост промпта за ход в токенах. Защищается `L + next_prompt_estimate - threshold` токенов ветки (`L` — максимальная длина диалога на этом пути), остальное вытесняется первым. На поведение влияет только разность `threshold - next_prompt_estimate`.

## Значения и формат

- JSON-объект в одинарных кавычках оболочки: `'{"protected_threshold": 4}'`, `'{"threshold": 4096, "next_prompt_estimate": 512}'`.
- Неизвестный ключ — `TypeError` при создании стратегии, с именем класса и ключа (например, `SLRUStrategy.__init__() got an unexpected keyword argument 'protected_treshold'`). Проверка происходит при построении дерева кеша, то есть после загрузки весов.
- `tlru` проверяется раньше, при резолве аргументов на старте (шаг `handle_cache_compatibility`): оба значения должны быть неотрицательными, а `threshold` — строго больше `next_prompt_estimate`. Отсутствующий ключ считается нулем, поэтому `tlru` без этого флага не стартует.
- В статье T-LRU оба параметра заданы в блоках; здесь — в токенах, то есть значения из статьи умножаются на `--page-size`.

## Когда использовать

- `slru`: поднимайте `protected_threshold`, если защищённый сегмент разрастается за счет префиксов, которые были переиспользованы пару раз и больше не нужны; опускайте до 1, если хотите «LRU с одной поблажкой за повтор». Меняйте только против измеренного cache hit rate.
- `tlru`: обязательно. `threshold` — целевой TTFT, деленный на измеренное время prefill одного некешированного токена; `next_prompt_estimate` — средний прирост промпта за ход по вашему трафику.
- С `lru`, `lfu`, `priority` флаг не задавайте.

## Влияние на производительность и память

Объём KV-пула не меняется. Параметры влияют только на порядок вытеснения и через него — на hit rate и TTFT при памяти под давлением.

## Взаимодействие с другими аргументами

- `--radix-eviction-policy`: определяет, какие ключи допустимы; без `slru`/`tlru` флаг либо бесполезен, либо ломает старт.
- `--page-size`: пересчет параметров T-LRU из блоков статьи в токены.
- `--disable-radix-cache`: дерева нет, параметры не используются.

## Типовые проблемы и диагностика

- `TypeError: <Strategy>.__init__() got an unexpected keyword argument '<key>'` (или `LRUStrategy() takes no arguments`) — опечатка в ключе либо параметры для политики, которая их не принимает.
- `ValueError: --radix-eviction-policy tlru needs 'threshold' greater than 'next_prompt_estimate' in --radix-eviction-policy-config, got X <= Y; otherwise no tokens are ever TEL-safe and T-LRU is exactly LRU.` — увеличьте `threshold` или задайте параметры вовсе.
- `ValueError: --radix-eviction-policy tlru requires non-negative 'threshold' and 'next_prompt_estimate'…` — отрицательные значения.
- Принятый объект виден в дампе `server_args=` при старте; эффект оценивайте по cache hit rate (`--enable-metrics`) и `cached_tokens`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy slru --radix-eviction-policy-config '{"protected_threshold": 4}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --radix-eviction-policy tlru --radix-eviction-policy-config '{"threshold": 4096, "next_prompt_estimate": 512}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/utils.py`
- `sglang/python/sglang/srt/mem_cache/evict_policy.py`
- `sglang/python/sglang/srt/mem_cache/rust_tree_core/adapter.py`
- `sglang/docs/docs/advanced_features/radix_eviction_policy.mdx`
- upstream PR #34012 «Add Agentic-Aware Tail-Optimized LRU eviction to the unified radix cache» (коммит `1a90ae6727` в checkout)
