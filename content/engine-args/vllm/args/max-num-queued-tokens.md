---
schema: 1
engine: vllm
primaryName: "--max-num-queued-tokens"
title: "--max-num-queued-tokens"
summary: Ограничивает сумму prompt-токенов запросов в prefill-очереди; при превышении возвращает HTTP 503.
group: SchedulerConfig
related: 
  - --max-num-queued-reqs
---

# --max-num-queued-tokens

## Кратко

Ограничивает сумму prompt-токенов запросов в prefill-очереди; при превышении возвращает HTTP 503.

## Оригинальная справка

```text
Maximum total prompt tokens of requests currently in the prefill
phase, or None for no limit. When the limit is reached, new requests
are rejected with HTTP 503.

This is a TTFT QoS mechanism: by setting it to
``target_TTFT * prefill_throughput`` you reject requests when the
prefill backlog would exceed the latency target.  In a disaggregated
prefill-decode setup this maps directly to the prefill pool's
capacity.

Like ``max_num_queued_reqs``, this limit is enforced in the API
server process and covers the prefill backlog across all DP ranks it
routes to, so ``prefill_throughput`` in the formula above is the
aggregate throughput of the deployment.

Note: the count is conservative.  A partially prefilled request
still contributes its full ``prompt_len`` until it transitions out
of the prefill phase, because the scheduler's per-iteration
``num_computed_tokens`` progress is not propagated to the API
server process during prefill (``EngineCoreOutput`` is only
emitted once the request starts producing tokens).  Similarly,
prefix-cache hits (``num_cached_tokens``) are only known to the
OutputProcessor after prefill completes.  This overestimates the
real backlog, causing earlier rejection than strictly necessary
— the safe direction for QoS.  The impact is limited to long
prompts under chunked prefill; short prompts that prefill in a
single iteration are unaffected.
```

## Паспорт аргумента

- Флаги: `--max-num-queued-tokens`
- Группа argparse: `SchedulerConfig`
- Тип значения: `int`
- Значение по умолчанию в декларации: `Field(default=None, ge=0)`
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.max_num_queued_tokens`

## Что меняет в движке

Лимит применяется API-сервером ко всем DP-рангам, которые он маршрутизирует.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Для цели TTFT ориентируйтесь на target_TTFT × prefill_throughput; None отключает ограничение.

## Влияние на производительность и память

Сдерживает хвост задержки prefill ценой отклонения запросов при перегрузке.

## Взаимодействие с другими аргументами

Связанные флаги: `--max-num-queued-reqs`.

## Типовые проблемы и диагностика

При 503 сравните prefill backlog с лимитом и проверьте retry клиента.

## Примеры

```bash
vllm serve /models/model --max-num-queued-tokens 8192
```

## Источники

- `vllm/vllm/config/scheduler.py`
