---
schema: 1
engine: sglang
primaryName: "--enable-lean-attention"
title: "--enable-lean-attention"
summary: "Управляет Lean Attention в Triton decode для длинных контекстов. При отсутствии флага движок выбирает ядро по условиям батча и CUDA graph."
group: exec.kernel
related:
  - --attention-backend
  - --decode-attention-backend
  - --context-length
---

# --enable-lean-attention

## Кратко

Управляет Lean Attention в Triton decode для длинных контекстов. При отсутствии флага движок выбирает ядро по условиям батча и CUDA graph.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Enable Lean (Work-Centric) Attention decode kernel for long-context serving. When None (default), uses auto-gate that activates Lean for long contexts and falls back to standard kernel for short contexts. Set to True to force enable, False to force disable.
```

## Паспорт аргумента

- Флаг: `--enable-lean-attention`
- Группа: `exec.kernel`
- Тип: `bool`
- Декларативный default: `null`
- Объявление: `ServerArgs.enable_lean_attention` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

TritonBackend передаёт решение в Work-Centric decode kernel. В eager auto-режиме учитываются реальные длины, batch size, группы голов и MLA; при capture длины фиктивные, поэтому используется отдельная capture policy по известным формам. `SGLANG_DISABLE_LEAN_ATTENTION` принудительно выключает Lean даже при явном флаге.

## Значения и формат

Декларативное значение `None` включает auto-gate. CLI объявлен через `store_true`: `--enable-lean-attention` без значения задаёт True. Хотя английская справка описывает False, отрицательного CLI-флага нет; для принудительного отключения используйте `SGLANG_DISABLE_LEAN_ATTENTION=1`.

## Когда использовать

Для измерения Triton decode на длинных контекстах и неодинаковых длинах последовательностей. Автоматический режим сохраняет обычное ядро там, где Lean не выбран.

## Влияние на производительность и память

Persistent CTA распределяет работу decode по контексту. Эффект зависит от длины и размера батча; принудительное включение на коротких контекстах может увеличить latency. Размер весов и KV-пула флаг не уменьшает.

## Взаимодействие с другими аргументами

Читается Triton attention backend, а не всеми attention backend. CUDA graph меняет способ auto-gate; общий выключатель окружения имеет высший приоритет.

## Типовые проблемы и диагностика

Проверьте фактический `--attention-backend` или `--decode-attention-backend`. Для сравнения auto/выключено запускайте одинаковую нагрузку с kill-switch и без него; `--enable-lean-attention False` не является поддерживаемым синтаксисом.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --attention-backend triton --enable-lean-attention
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
