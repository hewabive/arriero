---
schema: 1
engine: sglang
primaryName: "--hicache-storage-prefetch-retry-poll-interval"
title: "--hicache-storage-prefetch-retry-poll-interval"
summary: "Повторяет проверку L3 после промаха prefetch с задержкой в проходах scheduler. Ноль выключает повторы."
group: memory
related:
  - --hicache-storage-backend
  - --hicache-storage-prefetch-retry-max-attempts
---

# --hicache-storage-prefetch-retry-poll-interval

## Кратко

Повторяет проверку L3 после промаха prefetch с задержкой в проходах scheduler. Ноль выключает повторы.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Scheduling passes a queued request waits after a storage prefetch miss before the availability check is retried (under load the first check can run before the needed backup commits). 0 disables retries.
```

## Паспорт аргумента

- Флаг: `--hicache-storage-prefetch-retry-poll-interval`
- Группа: `memory`
- Тип: `int`
- Декларативный default: `0`
- Объявление: `ServerArgs.hicache_storage_prefetch_retry_poll_interval` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

Scheduler отмечает storage miss у ожидающего запроса, обнуляет счётчик ожидания и повторно вызывает `_prefetch_kvcache`, когда число проходов превысит interval. Проверяется вся waiting queue, а не только её первый запрос; pacing одинаков для TP rank.

## Значения и формат

Целое число проходов. Default `0` отключает; положительное N пропускает N проходов и допускает повтор на следующем. Это не миллисекунды и не таймаут storage.

## Когда использовать

Когда первая проверка доступности KV приходит до завершения backup и даёт временный промах под нагрузкой.

## Влияние на производительность и память

Добавляет обращения к storage, но может избежать повторного prefill. Не увеличивает KV-пул напрямую; частые повторы создают CPU/I/O нагрузку.

## Взаимодействие с другими аргументами

Нужен работающий HiCache storage. `--hicache-storage-prefetch-retry-max-attempts` ограничивает повторы на запрос, не время ожидания.

## Типовые проблемы и диагностика

Debug-лог `HiCache storage prefetch retry req=... attempt=...` показывает реальные повторы. При interval 0 их не будет; уже вышедший из waiting queue запрос не участвует.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-hierarchical-cache --hicache-storage-backend file --hicache-storage-prefetch-retry-poll-interval 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
