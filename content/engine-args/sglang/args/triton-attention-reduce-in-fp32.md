---
schema: 1
engine: sglang
primaryName: "--triton-attention-reduce-in-fp32"
title: "--triton-attention-reduce-in-fp32"
summary: Исторический флаг Triton-внимания, оставшийся от удаленной фичи double sparsity. В текущем checkout'е его значение не читает ни один потребитель — аргумент принимается и не делает ничего.
group: exec.kernel
related:
  - --attention-backend
  - --decode-attention-backend
  - --triton-attention-num-kv-splits
  - --dtype
  - --kv-cache-dtype
---

# --triton-attention-reduce-in-fp32

## Кратко

`--triton-attention-reduce-in-fp32` объявлен как переключатель точности промежуточной редукции в Triton-ядрах внимания. В checkout'е, по которому снят extract, поле `ServerArgs.triton_attention_reduce_in_fp32` не читается больше нигде: единственными его потребителями были ядра double sparsity, удаленные апстримом. Флаг остается в `--help` и в дампе `server_args=`, но на вычисления не влияет. Не тратьте на него время при подборе конфигурации.

## Оригинальная справка

```text
Cast the intermediate attention results to fp32 to avoid possible crashes related to fp16.This only affects Triton attention kernels.
```

## Паспорт аргумента

- Флаги: `--triton-attention-reduce-in-fp32`
- Группа: `exec.kernel`
- Тип значения: bool (флаг без значения; выставляет поле в `True`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется ничем — и не читается ничем. Поиск по всему checkout'у (`grep -rn "reduce_in_fp32"`) дает ровно одно вхождение: объявление в `sglang/python/sglang/srt/server_args.py`
- Где объявлен: `ServerArgs.triton_attention_reduce_in_fp32`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: формально обычный, фактически неиспользуемый (dead knob). В `--help` показывается, `hidden` не выставлен, `Deprecated*Action` не назначен
- Этап применения: только разбор CLI

## Что меняет в движке

В текущем состоянии кода — ничего.

Исторический контекст, подтверждаемый историей checkout'а: значение читалось в `sglang/python/sglang/srt/layers/attention/double_sparsity_backend.py` и `triton_ops/double_sparsity_attention.py`, где оно выбирало `reduce_dtype` (`torch.float32` против `torch.float16`) и константы `REDUCE_TRITON_TYPE`/`REDUCE_TORCH_TYPE`. Оба файла удалены коммитом `44e67c6835` «Remove deprecated double sparsity feature (#23009)» (17 апреля 2026), а объявление аргумента осталось. Обычные Triton-ядра внимания (`triton_backend.py` и `triton_ops/` рядом) о нем не знают: их промежуточные буферы `attn_logits`/`attn_lse` уже создаются в fp32 безусловно.

Смысл справки — «спасти от переполнений fp16» — сегодня закрыт другим: `--dtype` для активаций и `--kv-cache-dtype` для хранения KV, а точность редукции decode-ядра Triton не настраивается вовсе.

## Значения и формат

- Флаг без аргумента: указание выставляет `True`, отсутствие — `False`. Парной формы `--no-triton-attention-reduce-in-fp32` нет (`action` в extract пуст, `BooleanOptionalAction` не используется).
- Оба значения приводят к одинаковому поведению сервера.

## Когда использовать

- Не использовать. Единственная причина увидеть этот флаг — чужой конфиг, скопированный из старой инструкции по double sparsity.
- Если вы искали способ поднять точность внимания — смотрите `--dtype` (тип активаций и весов) и `--kv-cache-dtype` (тип KV-кеша); для воспроизводимости результатов — `--enable-deterministic-inference`, который фиксирует порядок редукции через `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE`.

## Влияние на производительность и память

Влияния нет: значение не доходит ни до одного ядра. Ни VRAM, ни время старта, ни latency от него не зависят.

## Взаимодействие с другими аргументами

- `--attention-backend` / `--decode-attention-backend`: даже при `triton` флаг не читается.
- `--triton-attention-num-kv-splits`, `--triton-attention-split-tile-size`: реально работающие ручки Triton-декода, в отличие от этой.
- `--dtype`, `--kv-cache-dtype`: то, чем действительно управляют точностью.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но ничего не изменилось. **Причина:** у него нет потребителей. **Проверка:** значение видно в дампе `server_args=` при старте — это единственное место, где оно вообще проявляется.
- **Симптом:** аргумент отвергнут установленной сборкой. **Причина:** пакет `sglang-kt` разошелся с checkout'ом. **Проверка:** `python -m sglang.launch_server --help` в окружении инстанса.
- **Риск на будущее:** аргумент, который ничего не делает, может быть удален апстримом без предупреждения — тогда конфиг с ним перестанет стартовать. Убирайте его из инстансов arriero заранее.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend triton --triton-attention-reduce-in-fp32
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend triton --dtype bfloat16 --kv-cache-dtype fp8_e4m3
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- коммит checkout'а `44e67c6835` «Remove deprecated double sparsity feature (#23009)» — удаление последних потребителей поля
