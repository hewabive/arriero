---
schema: 1
engine: vllm
primaryName: "--enable-batch-sharded-sampling"
title: "--enable-batch-sharded-sampling"
summary: Распределяет sampling разных запросов батча между tensor-parallel рангами.
group: ParallelConfig
related: 
  - --tensor-parallel-size
  - --max-num-seqs
---

# --enable-batch-sharded-sampling

## Кратко

Распределяет sampling разных запросов батча между tensor-parallel рангами.

## Оригинальная справка

```text
Use sharded sampling across tensor parallel ranks. Each rank samples
a slice of the batch instead of every rank sampling all of it. Currently
defaults to False if not set. Enabling it explicitly raises when the config
cannot support it (`tensor_parallel_size` must be > 1, `max_num_seqs` at
least `tensor_parallel_size`, and `max_logprobs` non-negative). Models opt in
by implementing `compute_logits_local`.
```

## Паспорт аргумента

- Флаги: `--enable-batch-sharded-sampling`, `--no-enable-batch-sharded-sampling`
- Группа argparse: `ParallelConfig`
- Тип значения: `bool`
- Значение по умолчанию в декларации: `None`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_batch_sharded_sampling`

## Что меняет в движке

Каждый TP-ранг обрабатывает часть батча вместо повторного sampling всего батча на каждом ранге; модель должна реализовать compute_logits_local.

## Значения и формат

Парная форма `--no-enable-batch-sharded-sampling` выключает значение; отсутствие флага оставляет значение по умолчанию.

## Когда использовать

Включайте только при TP > 1, max_num_seqs не меньше TP и неотрицательном max_logprobs. По умолчанию выключено.

## Влияние на производительность и память

Уменьшает дублирование sampling под большим батчем, но требует поддерживаемой модели.

## Взаимодействие с другими аргументами

Связанные флаги: `--tensor-parallel-size`, `--max-num-seqs`.

## Типовые проблемы и диагностика

При ошибке конфигурации проверьте три ограничения и наличие compute_logits_local у модели.

## Примеры

```bash
vllm serve /models/model --enable-batch-sharded-sampling
```

## Источники

- `vllm/vllm/config/parallel.py`
