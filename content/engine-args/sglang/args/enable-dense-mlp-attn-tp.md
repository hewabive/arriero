---
schema: 1
engine: sglang
primaryName: "--enable-dense-mlp-attn-tp"
title: "--enable-dense-mlp-attn-tp"
summary: "В Kimi K3 распределяет dense MLP по attention-TP группе при DP attention. Сохраняет отдельную схему вычислений для каждой DP-реплики."
group: parallel
related:
  - --enable-dp-attention
  - --tp-size
  - --dp-size
  - --enable-shared-experts-attn-tp
---

# --enable-dense-mlp-attn-tp

## Кратко

В Kimi K3 распределяет dense MLP по attention-TP группе при DP attention. Сохраняет отдельную схему вычислений для каждой DP-реплики.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Shard dense MLP weights across the attention TP group under DP attention.
```

## Паспорт аргумента

- Флаг: `--enable-dense-mlp-attn-tp`
- Группа: `parallel`
- Тип: `bool`
- Декларативный default: `false`
- Объявление: `ServerArgs.enable_dense_mlp_attn_tp` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

KimiK3MLP выбирает `attn_tp_rank` и `attn_tp_size` при включённом DP attention, если конструктору не передали явные TP-параметры. Без флага GPU-путь собирает DP-строки и распределяет dense MLP по полной TP-группе. Это модельная настройка Kimi K3, не универсальная перестройка всех MLP в SGLang.

## Значения и формат

Флаг без значения; по умолчанию выключен. Без DP attention условие `_dense_attn_tp` не срабатывает.

## Когда использовать

Для Kimi K3, когда нужен attention-TP layout dense MLP, в частности при настройке NPU-пути.

## Влияние на производительность и память

При attention-TP группе меньше полной TP каждый rank хранит большую долю dense-весов; распределение коммуникаций также меняется. Измеряйте память на rank и latency.

## Взаимодействие с другими аргументами

Требует `--enable-dp-attention`; ширина группы зависит от `--tp-size` и `--dp-size`. `--enable-shared-experts-attn-tp` отдельно управляет shared experts.

## Типовые проблемы и диагностика

Проверьте архитектуру модели, итоговые TP/DP размеры и `server_args=`. Сам факт принятия флага не означает, что другая модель его использует.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3 --tp-size 8 --dp-size 2 --enable-dp-attention --enable-dense-mlp-attn-tp
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/models/kimi_k3.py`
