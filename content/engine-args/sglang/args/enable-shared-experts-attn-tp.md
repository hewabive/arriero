---
schema: 1
engine: sglang
primaryName: "--enable-shared-experts-attn-tp"
title: "--enable-shared-experts-attn-tp"
summary: "В Kimi K3 меняет распределение shared experts при EP all-to-all. При DP attention использует attention-TP группу вместо полной репликации весов."
group: parallel
related:
  - --moe-a2a-backend
  - --enable-dp-attention
  - --enable-dense-mlp-attn-tp
  - --tp-size
  - --dp-size
---

# --enable-shared-experts-attn-tp

## Кратко

В Kimi K3 меняет распределение shared experts при EP all-to-all. При DP attention использует attention-TP группу вместо полной репликации весов.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Shard shared expert weights across the attention TP group when using an expert-parallel all-to-all backend.
```

## Паспорт аргумента

- Флаг: `--enable-shared-experts-attn-tp`
- Группа: `parallel`
- Тип: `bool`
- Декларативный default: `false`
- Объявление: `ServerArgs.enable_shared_experts_attn_tp` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

По умолчанию Kimi K3 реплицирует shared experts с TP=1 при EP all-to-all. Флаг снимает `_shared_experts_tp1`; при DP attention и `attn_tp_size > 1` задаёт attention-TP rank/size, собирает входы shared-ветки и выполняет reduce-scatter выхода обратно к локальным DP-строкам. Routed experts остаются в своей ветке.

## Значения и формат

Флаг без значения, по умолчанию выключен. Конкретный эффект определяется EP all-to-all, DP attention и числом shared experts модели.

## Когда использовать

Для совместимого Kimi K3, когда требуется шардирование shared-весов, в частности для NPU layout.

## Влияние на производительность и память

Вместо полной реплики shared-весов rank хранит долю группы; это экономит память ценой коммуникаций shared-ветки. Выигрыш зависит от размера attention-TP и батча.

## Взаимодействие с другими аргументами

Используется вместе с EP all-to-all через `--moe-a2a-backend`; `--enable-dp-attention`, TP и DP определяют группу. Dense MLP настраивается отдельно.

## Типовые проблемы и диагностика

Проверьте наличие shared experts у модели и фактический A2A backend. При attention-TP размере 1 распределять веса по нескольким rank невозможно.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3 --tp-size 8 --dp-size 2 --enable-dp-attention --moe-a2a-backend deepep --enable-shared-experts-attn-tp
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/models/kimi_k3.py`
