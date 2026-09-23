---
schema: 1
engine: vllm
primaryName: "--max-num-queued-reqs"
title: "--max-num-queued-reqs"
summary: Ограничивает число запросов в полёте на API-сервере; при заполнении возвращает HTTP 503.
group: SchedulerConfig
related: 
  - --max-num-seqs
  - --data-parallel-size
---

# --max-num-queued-reqs

## Кратко

Ограничивает число запросов в полёте на API-сервере; при заполнении возвращает HTTP 503.

## Оригинальная справка

```text
Maximum number of requests that can be in-flight (waiting or running)
at the same time, or None for no limit. When the limit is reached, new
requests are rejected with HTTP 503 so the client can retry on another
instance. This bounds vLLM's otherwise unbounded request queue and is
primarily a coarse capacity valve.

Unlike ``max_num_seqs``, which applies per data-parallel rank, this
limit is enforced in the API server process and counts in-flight
requests across all DP ranks it routes to. Size it as roughly
``data_parallel_size * max_num_seqs`` plus the desired queue depth if
it should not bind before per-rank admission does.
```

## Паспорт аргумента

- Флаги: `--max-num-queued-reqs`
- Группа argparse: `SchedulerConfig`
- Тип значения: `int`
- Значение по умолчанию в декларации: `Field(default=None, ge=0)`
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.max_num_queued_reqs`

## Что меняет в движке

Считаются ожидающие и выполняющиеся запросы через все DP-ранги, обслуживаемые процессом API.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Подберите data_parallel_size × max_num_seqs плюс желаемую глубину очереди; None не вводит лимит.

## Влияние на производительность и память

Ограничивает рост очереди и памяти запросов, но приводит к отказам 503 под пиком нагрузки.

## Взаимодействие с другими аргументами

Связанные флаги: `--max-num-seqs`, `--data-parallel-size`.

## Типовые проблемы и диагностика

При 503 измерьте текущую нагрузку и настройте повтор на другом инстансе у клиента.

## Примеры

```bash
vllm serve /models/model --max-num-queued-reqs 128
```

## Источники

- `vllm/vllm/config/scheduler.py`
