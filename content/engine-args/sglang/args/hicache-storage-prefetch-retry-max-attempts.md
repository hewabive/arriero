---
schema: 1
engine: sglang
primaryName: "--hicache-storage-prefetch-retry-max-attempts"
title: "--hicache-storage-prefetch-retry-max-attempts"
summary: "Ограничивает повторные проверки L3 для ожидающего запроса, включая немедленные повторы после переноса данных. После достижения лимита запрос продолжит обработку с доступным KV-кешем."
group: memory
related:
  - --hicache-storage-backend
  - --hicache-storage-prefetch-retry-poll-interval
---

# --hicache-storage-prefetch-retry-max-attempts

## Кратко

Ограничивает повторные проверки L3 для ожидающего запроса, включая немедленные повторы после переноса данных. После достижения лимита запрос продолжит обработку с доступным KV-кешем.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Storage availability re-issues a queued request may make, paced miss polls and immediate re-issues alike; past the cap it is admitted with whatever the device holds. 0 disables re-issues.
```

## Паспорт аргумента

- Флаг: `--hicache-storage-prefetch-retry-max-attempts`
- Группа: `memory`
- Тип: `int`
- Декларативный default: `8`
- Объявление: `ServerArgs.hicache_storage_prefetch_retry_max_attempts` в `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

В `_process_storage_prefetch_retries` scheduler вызывает `pop_ready` для waiting queue. `_retry_storage_prefetch` увеличивает счётчик перед повторным `_prefetch_kvcache`. Лимит охватывает как ожидание после промаха, так и немедленную повторную проверку после перемещения совпавшего диапазона.

## Значения и формат

Целое число; default `8`. `0` не допускает повторов. Положительный poll interval нужен только для повторов после промаха; немедленные повторные проверки учитываются независимо от него.

## Когда использовать

Для ограничения нагрузки на L3 при временных промахах и медленном завершении backup.

## Влияние на производительность и память

Больший лимит даёт больше шансов дождаться KV, но увеличивает число storage-проверок. Размер host/GPU pool не меняет.

## Взаимодействие с другими аргументами

`--hicache-storage-prefetch-retry-poll-interval` задаёт паузу после промаха. Значение `0` отключает эти повторы, но не немедленные проверки после перемещения совпавшего диапазона.

## Типовые проблемы и диагностика

Смотрите `HiCache storage prefetch re-issue` на debug-уровне и `HiCache storage prefetch reissue cap reached` в warning-логе. Достижение лимита прекращает проверки L3 и допускает запрос с доступным KV-кешем.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-hierarchical-cache --hicache-storage-backend file --hicache-storage-prefetch-retry-poll-interval 2 --hicache-storage-prefetch-retry-max-attempts 4
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
