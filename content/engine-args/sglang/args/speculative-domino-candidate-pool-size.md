---
schema: 1
engine: sglang
primaryName: "--speculative-domino-candidate-pool-size"
title: "--speculative-domino-candidate-pool-size"
summary: Задаёт размер приблизительного пула кандидатов базовых logits для Domino speculative decoding. Ноль включает оценку полного словаря.
group: spec
related:
  - --speculative-algorithm
---

# --speculative-domino-candidate-pool-size

## Кратко

Задаёт размер приблизительного пула кандидатов базовых logits для Domino speculative decoding. Ноль включает оценку полного словаря.

## Оригинальная справка

```text
Domino only. Size of the approximate block-shared base-logit candidate pool. Set to 0 to score the full vocabulary.
```

## Паспорт аргумента

- Флаги: `--speculative-domino-candidate-pool-size`
- Группа: `spec`
- Тип: `int`
- Значение в декларации по умолчанию: `2048`
- Объявление: `ServerArgs.speculative_domino_candidate_pool_size` в `sglang/python/sglang/srt/arg_groups/fields/spec.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Domino worker передаёт размер в алгоритм выбора кандидатов; ограниченный пул сокращает число проверяемых token ID при оценке базовых logits.

## Значения и формат

Неотрицательное целое; по умолчанию `2048`. `0` выбирает полный словарь, отрицательное значение вызывает ошибку.

## Когда использовать

Меняйте при измерениях точности и задержки Domino; `0` полезен как контрольная точка без приближённого отбора.

## Влияние на производительность и память

Увеличение пула повышает вычислительную работу и объём промежуточных данных; меньший пул экономит ресурсы ценой приближённого отбора.

## Взаимодействие с другими аргументами

Используется только с Domino в `--speculative-algorithm`; на другие алгоритмы спекуляции не действует.

## Типовые проблемы и диагностика

Отрицательное значение даёт `ValueError` при инициализации Domino worker. Сравнивайте acceptance rate и latency на одинаковом наборе запросов.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --speculative-algorithm DOMINO --speculative-domino-candidate-pool-size 2048
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/spec.py`
- `sglang/python/sglang/srt/speculative/dflash_worker_v2.py`
- `sglang/python/sglang/srt/speculative/domino_utils.py`
