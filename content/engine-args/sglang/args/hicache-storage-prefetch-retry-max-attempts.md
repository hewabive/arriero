---
schema: 1
engine: sglang
primaryName: "--hicache-storage-prefetch-retry-max-attempts"
title: "--hicache-storage-prefetch-retry-max-attempts"
summary: "Ограничивает количество повторных L3-prefetch на один ожидающий запрос. Действует только при включённом интервале повторов."
group: memory
related:
  - --hicache-storage-backend
  - --hicache-storage-prefetch-retry-poll-interval
---

# --hicache-storage-prefetch-retry-max-attempts

## Кратко

Ограничивает количество повторных L3-prefetch на один ожидающий запрос. Действует только при включённом интервале повторов.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Maximum storage prefetch retries per request when --hicache-storage-prefetch-retry-poll-interval is set.
```

## Паспорт аргумента

- Флаг: `--hicache-storage-prefetch-retry-max-attempts`
- Группа: `memory`
- Тип: `int`
- Декларативный default: `4`
- Объявление: `ServerArgs.hicache_storage_prefetch_retry_max_attempts` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

В `_retry_missed_storage_prefetches` scheduler сравнивает `storage_prefetch_retry_attempts` с лимитом перед повтором. Счётчик увеличивается только при повторном `_prefetch_kvcache`; исходная попытка в лимит повторов не входит.

## Значения и формат

Целое число; default `4`. `0` не допускает повторов. Для включения задайте также положительный poll interval.

## Когда использовать

Для ограничения нагрузки на L3 при временных промахах и медленном завершении backup.

## Влияние на производительность и память

Больший лимит даёт больше шансов дождаться KV, но увеличивает число storage-проверок. Размер host/GPU pool не меняет.

## Взаимодействие с другими аргументами

Без `--hicache-storage-prefetch-retry-poll-interval > 0` значение не действует. Повторы касаются waiting queue, а не уже исполняемых запросов.

## Типовые проблемы и диагностика

Смотрите `HiCache storage prefetch retry` на debug-уровне и номер attempt. Достижение лимита прекращает повторы, а не завершает запрос ошибкой.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-hierarchical-cache --hicache-storage-backend file --hicache-storage-prefetch-retry-poll-interval 2 --hicache-storage-prefetch-retry-max-attempts 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
