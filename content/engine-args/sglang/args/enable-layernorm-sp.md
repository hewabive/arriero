---
schema: 1
engine: sglang
primaryName: "--enable-layernorm-sp"
title: "--enable-layernorm-sp"
summary: "Разделяет LayerNorm/residual активации по последовательности во время prefill Qwen3 dense. Требует чистый TP и быстрое межсоединение."
group: parallel
related:
  - --tp-size
  - --enable-dp-attention
  - --speculative-algorithm
---

# --enable-layernorm-sp

## Кратко

Разделяет LayerNorm/residual активации по последовательности во время prefill Qwen3 dense. Требует чистый TP и быстрое межсоединение.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Enable Megatron-style sequence parallelism (arXiv:2205.05198) for the LayerNorm/residual regions under pure tensor parallelism: the row-parallel all-reduce becomes reduce-scatter + all-gather, so LayerNorm runs on sequence-sharded activations with no extra communication volume. Prefill only; Qwen3 dense; requires tp_size > 1 and NVLink/NVSwitch.
```

## Паспорт аргумента

- Флаг: `--enable-layernorm-sp`
- Группа: `parallel`
- Тип: `bool`
- Декларативный default: `false`
- Объявление: `python/sglang/srt/arg_groups/fields/parallel.py:Parallel.enable_layernorm_sp`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

Проверка `handle_layernorm_sp` (`arg_groups/layernorm_sp_hook.py`, шаг пайплайна разрешения) допускает только `Qwen3ForCausalLM` и `tp_size > 1`, запрещает DP attention и любое speculative decoding.

Сам механизм — `layers/layernorm_sp.py` и вариант батча `SEQUENCE_PARALLEL` у границ стадий `layers/layer_boundary/`. Границы строят этот путь при построении модели, если `initialize_layernorm_sp` включил SP для архитектуры (`factories.py`). На forward режима `EXTEND` (`runs_sp`; `MIXED`, target-verify и decode идут обычным путем) первая стадия внимания в стеке ставит `sp_active` и режет скрытые состояния по токенам (`sp_entry_scatter`, padding до кратности `tp_size`, `stage.py`). По этому признаку `StagePlan._variant` (`construction.py`) выбирает SP-путь у каждой стадии. Участники в `layers/linear.py` меняют коллективы: `RowParallelLinear` (`o_proj`, `down_proj`) вместо all-reduce делает matmul + reduce-scatter, `ColumnParallelLinear` (`qkv`, `gate_up`) — all-gather + matmul. Для слоев без квантования и bias в bf16/fp16 используются слитые ядра `torch.ops.symm_mem`, если они есть. LayerNorm и residual между ними считаются над `1/tp_size` токенов, а перед LM head `maybe_exit_gather` (`layers/logits_processor.py`) собирает последовательность обратно.

## Значения и формат

Флаг без значения, по умолчанию выключен. Это prefill-оптимизация; decode не становится sequence-parallel.

## Когда использовать

Для Qwen3 dense на нескольких GPU с NVLink/NVSwitch при измеренной стоимости LayerNorm/residual в prefill.

## Влияние на производительность и память

Уменьшает объём активаций и LayerNorm-работы на rank; общий объём коммуникаций сохраняется, но меняется последовательность collective. На медленном межсоединении накладные расходы могут перекрыть пользу.

## Взаимодействие с другими аргументами

Нужен `--tp-size > 1`; несовместим с `--enable-dp-attention` и `--speculative-algorithm`.

## Типовые проблемы и диагностика

ValueError на старте прямо указывает неподдерживаемую архитектуру, TP=1, DP attention или спекуляцию. Сравнивайте prefill latency при одинаковой длине и batch size.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --tp-size 2 --enable-layernorm-sp
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/parallel.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/layernorm_sp_hook.py`
- `sglang/python/sglang/srt/layers/layernorm_sp.py`
- `sglang/python/sglang/srt/layers/layer_boundary/stage.py`
- `sglang/python/sglang/srt/layers/layer_boundary/construction.py`
- `sglang/python/sglang/srt/layers/layer_boundary/factories.py`
- `sglang/python/sglang/srt/layers/linear.py`
- `sglang/python/sglang/srt/layers/logits_processor.py`
