---
schema: 1
engine: sglang
primaryName: "--enable-unified-cache-external-linker"
title: "--enable-unified-cache-external-linker"
summary: Подключает UnifiedRadixCache напрямую к внешнему KV-хранилищу без промежуточного host cache. Используется при развёрнутом внешнем backend.
group: memory
related:
  - --unified-cache-external-linker-backend
  - --enable-hierarchical-cache
---

# --enable-unified-cache-external-linker

## Кратко

Подключает UnifiedRadixCache напрямую к внешнему KV-хранилищу без промежуточного host cache. Используется при развёрнутом внешнем backend.

## Оригинальная справка

```text
Link UnifiedRadixCache directly to an external KV store (direct L3), with no host cache tier.
```

## Паспорт аргумента

- Флаги: `--enable-unified-cache-external-linker`
- Группа: `memory`
- Тип: `bool`
- Значение в декларации по умолчанию: `false`
- Объявление: `ServerArgs.enable_unified_cache_external_linker` в `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

При создании дерева KV `registry.py` выбирает direct linker и регистрирует счётчик передачи слоёв. Данные могут загружаться из внешнего хранилища вместо локального host tier.

## Значения и формат

Булев флаг, по умолчанию выключен. Backend выбирается отдельным `--unified-cache-external-linker-backend`.

## Когда использовать

Используйте при настроенном Mooncake или MORI и проверенной доступности внешнего KV-хранилища.

## Влияние на производительность и память

Добавляет сетевые/внешние операции загрузки KV; выигрыш зависит от повторного использования префиксов и задержки хранилища. Host cache tier не создаётся.

## Взаимодействие с другими аргументами

Несовместим с `--enable-hierarchical-cache` и с заданным `--hicache-storage-backend`; конфликт проверяется на старте.

## Типовые проблемы и диагностика

При конфликте параметров `handle_hicache` выдаёт `ValueError`. При ошибках восстановления KV смотрите журналы direct linker и доступность внешнего сервиса.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --enable-unified-cache-external-linker --unified-cache-external-linker-backend mooncake
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/unified_cache_linker.py`
