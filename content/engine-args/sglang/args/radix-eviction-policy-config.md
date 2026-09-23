---
schema: 1
engine: sglang
primaryName: "--radix-eviction-policy-config"
title: "--radix-eviction-policy-config"
summary: Передаёт параметры выбранной политике вытеснения radix cache в виде JSON-объекта. Сейчас дополнительные параметры принимает только `slru`.
group: memory
related:
  - --radix-eviction-policy
  - --disable-radix-cache
---

# --radix-eviction-policy-config

## Кратко

Передаёт параметры выбранной политике вытеснения radix cache в виде JSON-объекта. Сейчас дополнительные параметры принимает только `slru`.

## Оригинальная справка

```text
Tuning parameters for --radix-eviction-policy, as a json object passed to the policy as keyword arguments. Only 'slru' takes any today: protected_threshold (int, default 2), e.g. '{"protected_threshold": 4}'. An unrecognized key fails at startup, naming the key and the policy. See https://docs.sglang.io/docs/advanced_features/radix_eviction_policy#policy-parameters for the full parameter list.
```

## Паспорт аргумента

- Флаги: `--radix-eviction-policy-config`
- Группа: `memory`
- Тип: `json`
- Значение в декларации по умолчанию: `null`
- Объявление: `ServerArgs.radix_eviction_policy_config` в `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

При создании дерева KV конфигурация передаётся фабрике политики как именованные аргументы. Для `slru` параметр `protected_threshold` задаёт число попаданий, после которого узел считается защищённым.

## Значения и формат

JSON-объект, например `{"protected_threshold": 4}`. У `slru` порог по умолчанию 2; неизвестный ключ вызывает ошибку запуска с названием ключа и политики.

## Когда использовать

Меняйте порог только при наблюдаемом вытеснении горячих префиксов и сравнении cache hit rate.

## Влияние на производительность и память

Объём KV-пула не меняется. Порог влияет на порядок вытеснения и косвенно на TTFT при повторяющихся промптах.

## Взаимодействие с другими аргументами

Имеет смысл только с `--radix-eviction-policy slru`; при `--disable-radix-cache` дерево не работает.

## Типовые проблемы и диагностика

Ошибка неизвестного параметра при старте указывает ключ и политику. Для оценки эффекта сравнивайте cache hit rate и `cached_tokens`.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --radix-eviction-policy slru --radix-eviction-policy-config '{"protected_threshold":4}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/evict_policy.py`
