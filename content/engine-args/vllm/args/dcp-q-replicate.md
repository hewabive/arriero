---
schema: 1
engine: vllm
primaryName: "--dcp-q-replicate"
title: "--dcp-q-replicate"
summary: Убирает all-gather query на каждом шаге MLA decode, дублируя небольшую query projection внутри DCP-группы.
group: ParallelConfig
related: 
  - --decode-context-parallel-size
---

# --dcp-q-replicate

## Кратко

Убирает all-gather query на каждом шаге MLA decode, дублируя небольшую query projection внутри DCP-группы.

## Оригинальная справка

```text
Replicate the MLA query projection within each DCP group so decode can skip the
query all-gather.

With DCP the KV cache is sharded across the group, so the standard MLA decode path
all-gathers the query every step. Replicating the (small) query projection at load
time lets each rank materialize the full group-local head set and skip that 
collective, at the cost of computing the projection redundantly on every rank 
in the group.
```

## Паспорт аргумента

- Флаги: `--dcp-q-replicate`, `--no-dcp-q-replicate`
- Группа argparse: `ParallelConfig`
- Тип значения: `bool`
- Значение по умолчанию в декларации: `None`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.dcp_q_replicate`

## Что меняет в движке

При загрузке проекция реплицируется на DCP-рангах; каждый ранг вычисляет полный набор query heads локально.

## Значения и формат

Парная форма `--no-dcp-q-replicate` выключает значение; отсутствие флага оставляет значение по умолчанию.

## Когда использовать

Включайте при MLA с decode context parallelism, если коммуникация query ограничивает decode. Значение None оставляет решение движку.

## Влияние на производительность и память

Меньше межранговых обменов на шаге decode, но больше вычислений и копий весов проекции.

## Взаимодействие с другими аргументами

Связанные флаги: `--decode-context-parallel-size`.

## Типовые проблемы и диагностика

Сравните latency decode и обмены между рангами до и после; вне DCP и MLA выигрыш не ожидается.

## Примеры

```bash
vllm serve /models/model --dcp-q-replicate
```

## Источники

- `vllm/vllm/config/parallel.py`
