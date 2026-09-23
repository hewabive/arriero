---
schema: 1
engine: vllm
primaryName: "--dp-sync-interval"
title: "--dp-sync-interval"
summary: Задаёт период синхронизации завершения между data-parallel рангами в шагах движка.
group: ParallelConfig
related: 
  - --data-parallel-size
---

# --dp-sync-interval

## Кратко

Задаёт период синхронизации завершения между data-parallel рангами в шагах движка.

## Оригинальная справка

```text
Steps between DP finish-sync all-reduces; must match across DP ranks.
```

## Паспорт аргумента

- Флаги: `--dp-sync-interval`
- Группа argparse: `ParallelConfig`
- Тип значения: `int`
- Значение по умолчанию в декларации: `Field(default=16, ge=1)`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.dp_sync_interval`

## Что меняет в движке

Каждый ранг участвует в finish-sync all-reduce через указанное число шагов; значение должно совпадать на всех рангах.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Меняйте только для настройки цены синхронизации в DP; допустимы целые значения от 1, декларативный default 16.

## Влияние на производительность и память

Меньший интервал увеличивает частоту коллективных операций, больший может задерживать согласование завершения.

## Взаимодействие с другими аргументами

Связанные флаги: `--data-parallel-size`.

## Типовые проблемы и диагностика

При зависании DP проверьте одинаковый параметр на всех рангах и логи коллективных операций.

## Примеры

```bash
vllm serve /models/model --dp-sync-interval 16
```

## Источники

- `vllm/vllm/config/parallel.py`
