---
schema: 1
engine: sglang
primaryName: "--speculative-dsa-topk-backend"
title: "--speculative-dsa-topk-backend"
summary: "Отдельно выбирает DSA top-k для draft workers. Значение target-параметра не наследуется."
group: spec
related:
  - --dsa-topk-backend
  - --speculative-algorithm
  - --speculative-draft-model-path
---

# --speculative-dsa-topk-backend

## Кратко

Отдельно выбирает DSA top-k для draft workers. Значение target-параметра не наследуется.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
DSA indexer top-k backend for speculative draft workers. Options: 'sgl-kernel', 'torch', 'flashinfer'. The 'torch' backend currently requires SGLANG_DSA_FUSE_TOPK=false.
```

## Паспорт аргумента

- Флаг: `--speculative-dsa-topk-backend`
- Группа: `spec`
- Тип: `str`
- Декларативный default: `"sgl-kernel"`
- Объявление: `ServerArgs.speculative_dsa_topk_backend` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI, инициализация и исполнение подсистемы, описанной ниже.

## Что меняет в движке

`DSATopKBackend.resolve` проверяет `model_runner.is_draft_worker`: draft читает этот параметр, target — `--dsa-topk-backend`. Управляет выбором top-k индексов sparse attention, а не количеством предлагаемых draft-токенов.

## Значения и формат

`sgl-kernel` по умолчанию; доступны `torch` и `flashinfer`. Для `torch` требуется `SGLANG_DSA_FUSE_TOPK=false`: fused top-k transform не реализует torch-ветку.

## Когда использовать

Для независимого сравнения DSA-индексатора draft без смены target backend. Нужен draft, использующий DSA.

## Влияние на производительность и память

Меняет время top-k draft и промежуточные вычисления, не задаёт размер основной модели или KV-пула. Измеряйте speculative latency и accept length.

## Взаимодействие с другими аргументами

Независим от `--dsa-topk-backend`; `--speculative-algorithm` и draft model определяют, создаётся ли соответствующий worker.

## Типовые проблемы и диагностика

Ошибка `Unsupported ... for SGLANG_DSA_FUSE_TOPK` с torch указывает на включённый fused путь. Для FlashInfer нужна установленная реализация используемых top-k API.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --speculative-algorithm EAGLE --speculative-dsa-topk-backend sgl-kernel
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/dsa/dsa_topk_backend.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
