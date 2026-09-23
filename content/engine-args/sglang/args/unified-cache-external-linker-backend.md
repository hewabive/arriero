---
schema: 1
engine: sglang
primaryName: "--unified-cache-external-linker-backend"
title: "--unified-cache-external-linker-backend"
summary: Выбирает реализацию внешнего KV-хранилища для прямого linker UnifiedRadixCache. Используется только вместе с включённым direct linker.
group: memory
related:
  - --enable-unified-cache-external-linker
  - --enable-hierarchical-cache
---

# --unified-cache-external-linker-backend

## Кратко

Выбирает реализацию внешнего KV-хранилища для прямого linker UnifiedRadixCache. Используется только вместе с включённым direct linker.

## Оригинальная справка

```text
Storage backend for --enable-unified-cache-external-linker.
```

## Паспорт аргумента

- Флаги: `--unified-cache-external-linker-backend`
- Группа: `memory`
- Тип: `str`
- Значение в декларации по умолчанию: `mooncake`
- Объявление: `ServerArgs.unified_cache_external_linker_backend` в `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

`registry.py` создаёт `MooncakeDirectLinker` либо `UMBPDirectLinker` (MORI) и регистрирует передачу слоёв KV.

## Значения и формат

`mooncake` по умолчанию или `mori`. Выбор сам по себе не включает direct linker.

## Когда использовать

Указывайте backend, который соответствует уже развёрнутому внешнему KV-сервису и его транспорту.

## Влияние на производительность и память

Задержка восстановления префиксов и сетевой трафик зависят от backend и инфраструктуры; размер локального KV-пула этим выбором не задаётся.

## Взаимодействие с другими аргументами

Требует `--enable-unified-cache-external-linker`; direct linker несовместим с `--enable-hierarchical-cache`.

## Типовые проблемы и диагностика

Неизвестное имя вызывает `ValueError` при создании дерева; при ошибках соединения смотрите журнал выбранного linker.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --enable-unified-cache-external-linker --unified-cache-external-linker-backend mori
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/storage/umbp/umbp_direct_linker.py`
