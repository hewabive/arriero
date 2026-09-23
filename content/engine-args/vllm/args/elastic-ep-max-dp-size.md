---
schema: 1
engine: vllm
primaryName: "--elastic-ep-max-dp-size"
title: "--elastic-ep-max-dp-size"
summary: Ограничивает максимальный размер data parallelism для elastic expert parallelism.
group: ParallelConfig
related: []
---

# --elastic-ep-max-dp-size

## Кратко

Ограничивает максимальный размер data parallelism для elastic expert parallelism.

## Оригинальная справка

```text
Maximum data parallel size supported by elastic expert parallelism.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-max-dp-size`
- Группа argparse: `ParallelConfig`
- Тип значения: `int`
- Значение по умолчанию в декларации: `Field(default=None, ge=1)`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.elastic_ep_max_dp_size`

## Что меняет в движке

Поле ParallelConfig используется при построении топологии elastic EP. None оставляет предел неопределённым.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Указывайте верхнюю границу запланированного масштабирования EP; значение должно быть положительным.

## Влияние на производительность и память

Большая граница может увеличить зарезервированные ресурсы и стоимость топологии; без elastic EP параметр не нужен.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

При отказе старта сверяйте число DP-рангов и настройку elastic EP.

## Примеры

```bash
vllm serve /models/model --elastic-ep-max-dp-size 8
```

## Источники

- `vllm/vllm/config/parallel.py`
