---
schema: 1
engine: vllm
primaryName: "--sparse-indexer-topk-backend"
title: "--sparse-indexer-topk-backend"
summary: Выбирает ядро top-k для DSA sparse indexer на decode.
group: KernelConfig
related: []
---

# --sparse-indexer-topk-backend

## Кратко

Выбирает ядро top-k для DSA sparse indexer на decode.

## Оригинальная справка

```text
Backend for the DSA sparse indexer decode top-k kernel. Available options:

- "auto": The pre-existing chain (cooperative -> persistent -> per_row);
  the other backends are opt-in
- "deep_select": Use DeepSelect kernels (SM100a/SM103a only)
- "cooperative": Use vLLM's cooperative_topk kernel
- "persistent": Use vLLM's persistent_topk kernel
- "per_row": Use vLLM's top_k_per_row_decode kernel
- "flashinfer": Use FlashInfer's top_k_ragged_transform kernel
- "torch": Use a plain torch.topk implementation (debug reference)

Explicit values raise RuntimeError when their constraints are not met.
```

## Паспорт аргумента

- Флаги: `--sparse-indexer-topk-backend`
- Группа argparse: `KernelConfig`
- Тип значения: `enum`
- Значение по умолчанию в декларации: `'auto'`
- Где объявлен: `vllm/config/kernel.py:KernelConfig.sparse_indexer_topk_backend`

## Что меняет в движке

auto использует цепочку cooperative, persistent, per_row; явные backend проверяют собственные ограничения.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Начните с auto; deep_select требует SM100a/SM103a, torch подходит как отладочный эталон.

## Влияние на производительность и память

Разные ядра меняют decode latency и рабочую память; сравнивайте на целевой GPU.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

RuntimeError при явном выборе означает, что ограничения backend не выполнены.

## Примеры

```bash
vllm serve /models/model --sparse-indexer-topk-backend auto
```

## Источники

- `vllm/vllm/config/kernel.py`
