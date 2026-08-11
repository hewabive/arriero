---
schema: 1
engine: sglang
primaryName: "--ep-size"
title: "--ep-size"
summary: На сколько групп рангов раскладываются эксперты MoE-слоя. Задается только при `--moe-a2a-backend none` — любой другой a2a-backend принудительно приравнивает значение к `--tp-size`.
group: parallel
related:
  - --moe-a2a-backend
  - --tp-size
  - --moe-dp-size
  - --moe-runner-backend
  - --enable-eplb
  - --ep-dispatch-algorithm
  - --ep-num-redundant-experts
  - --enable-dp-attention
  - --max-ep-size
  - --elastic-ep-backend
  - --deepep-mode
---

# --ep-size

## Кратко

`--ep-size` — размер группы экспертного параллелизма: сколько рангов делят между собой набор экспертов MoE-слоя. Он не самостоятелен: внутри TP-группы действует тождество `moe_tp_size = tp_size / ep_size / moe_dp_size`, то есть увеличение `ep_size` забирает ранги у тензорного шардирования экспертов. Значение по умолчанию `1` — эксперты не распределены, каждый ранг держит все веса экспертов, порезанные по TP. Практически аргумент имеет смысл ровно в одном режиме — при `--moe-a2a-backend none`; иначе он перетирается.

## Оригинальная справка

```text
The expert parallelism size.
```

## Паспорт аргумента

- Флаги: `--ep-size`, `--expert-parallel-size`, `--ep`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; делители `tp_size`, ограниченные соотношением `ep_size * moe_dp_size <= tp_size`
- Значение по умолчанию: `1`
- Эффективное значение: переписывается регулярно. `_a2a_ep_size` ставит `ep_size = tp_size` для всех a2a-backend'ов, кроме `none` (в лог идет `… MoE is enabled. The expert parallel size is adjusted from N to the tensor parallel size [M].`); `_handle_dwdp` ставит `ep_size = dwdp_size`; MLA CP и zigzag DSA CP выставляют `ep_size = tp_size`. Поле помечено `resolvable=True`, промежуточные обработчики читают его через `_resolved()`
- Где объявлен: `ServerArgs.ep_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_context_parallelism` → `_handle_a2a_moe` → `_handle_eplb_and_dispatch` → `_handle_elastic_ep`) → `initialize_model_parallel(expert_model_parallel_size=…)` → загрузка весов экспертов → каждый forward MoE-слоя

## Что меняет в движке

Значение приходит в `ParallelState.moe_ep_size` (`managers/scheduler.py`: `moe_ep_size=server_args.ep_size`) и дальше в `initialize_model_parallel`, где строятся группы `_MOE_EP`, `_MOE_TP` и `_MOE_DP`:

```python
moe_tp_size = tensor_model_parallel_size // moe_ep_size // moe_dp_size
```

При `ep_size == tp_size` группа `_MOE_EP` совпадает с TP-группой (на не-NPU это буквально один и тот же коммуникатор), `moe_tp_size == 1`, и каждый ранг держит `num_experts / ep_size` экспертов целиком. При `ep_size == 1` эксперты не распределены, зато каждый эксперт порезан по `moe_tp_size == tp_size` рангам — в MoE-слое стоит `assert intermediate_size % moe_tp_size == 0`.

Ранг эксперта на каждом воркере считается так (`entrypoints/engine.py:_compute_parallelism_ranks`):

```python
moe_ep_rank = tp_rank % (tp_size // moe_dp_size) // (tp_size // moe_dp_size // ep_size)
```

При `ep_size > 1` в префикс строк лога добавляется ` EP<rank>`.

Способ доставки токенов к их экспертам определяет **не** этот аргумент, а `--moe-a2a-backend`: при `none` используются обычные коллективы (все ранги считают один и тот же набор токенов и сводят результат All-Reduce), при остальных — dispatch/combine. Именно поэтому `none` — единственный режим, где `ep_size < tp_size` вообще возможен; подробности — в `moe-a2a-backend.md`.

## Значения и формат

- Целое ≥ 1. `1` — экспертного параллелизма нет.
- При `--moe-dp-size > 1`: `ep_size * moe_dp_size <= tp_size`, а при `ep_size > 1` — строгое равенство `ep_size * moe_dp_size == tp_size`.
- `tp_size` должен делиться на `ep_size` (иначе `moe_tp_size` посчитается неверно; на квантованных весах это ловится явной проверкой `tp_size {n} must be divisible by ep_size {m}` в `check_quantized_moe_compatibility`).
- Задавать `--ep-size` вместе с a2a-backend, отличным от `none`, бессмысленно: значение будет заменено на `tp_size`, и конфигурация окажется не той, что написана.

## Когда использовать

- Крупная MoE-модель, веса экспертов которой не помещаются на ранг: `--ep-size` раскладывает их и линейно уменьшает VRAM под эксперты.
- Гибрид EP+TP (`1 < ep_size < tp_size`), когда экспертов немного и полный EP дал бы слишком мелкие куски: возможен **только** при `--moe-a2a-backend none`.
- `--enable-eplb` требует `ep_size > 1` (`assert` в `_handle_eplb_and_dispatch`, кроме режима elastic-scale) — балансировать нечего, когда группа одна.
- Не трогайте на плотной (не-MoE) модели: аргумент влияет только на MoE-слои.
- Не задавайте вручную, если уже выбран `deepep`/`mooncake`/`nixl`/`mori`/`pplx`/`flashinfer`/`megamoe`/`ascend_fuseep`: значение станет равным `--tp-size`.

## Влияние на производительность и память

- **VRAM.** Веса экспертов делятся на `ep_size` (каждый ранг хранит `num_experts / ep_size` экспертов). Это обычно самая крупная статья у больших MoE, поэтому EP — основной способ поместить модель.
- **Коммуникация.** При `none` рост `ep_size` не убирает All-Reduce по всей группе; выигрыш от a2a-диспетчеров появляется только с настоящим a2a-backend'ом, который заодно выделяет собственные буферы (см. `moe-a2a-backend.md`).
- **Балансировка.** Чем больше `ep_size`, тем сильнее перекос по «горячим» экспертам; это лечат `--enable-eplb`, `--ep-num-redundant-experts` и `--ep-dispatch-algorithm`.
- **KV-кеш и внимание.** Не затрагиваются вовсе: `ep_size` живет только в MoE-слоях.
- **Время старта.** Растет незначительно; при `--enable-eplb` добавляется этап начальной раскладки экспертов.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: любое значение, кроме `none`, перетирает `--ep-size` значением `--tp-size`.
- `--tp-size` / `--moe-dp-size`: `moe_tp_size = tp_size / ep_size / moe_dp_size`, отсюда все ограничения делимости.
- `--moe-runner-backend triton_kernel`: `assert ep_size == 1`; FP8/MXFP8 Cutlass MoE — тоже `ep_size == 1`.
- `--enable-eplb`: требует `ep_size > 1`.
- `--ep-dispatch-algorithm`: при `--moe-a2a-backend none` допустимы только ранг-инвариантные алгоритмы (`static` и `lp` запрещены).
- `--enable-dp-attention`: не связан напрямую, но все практические EP-конфигурации крупных MoE идут вместе с ним.
- `--max-ep-size` / `--elastic-ep-backend`: elastic-scale требует `ep_size == tp_size` и `dp_size == tp_size`.
- `--moe-runner-backend flashinfer_cutedsl`: бюджет диспетчера проверяется как `max_dispatch_tokens_per_rank * ep_size` против максимального forward'а.

## Типовые проблемы и диагностика

- В логе `deepep MoE is enabled. The expert parallel size is adjusted from 4 to the tensor parallel size [8].` — ваше значение перетерто a2a-backend'ом.
- `AssertionError: ep_size * moe_dp_size must be equal to tp_size` — нарушено соотношение при `--moe-dp-size > 1`.
- `AssertionError: Triton kernel MoE is only supported when ep_size == 1` — конфликт с `--moe-runner-backend triton_kernel`.
- `ValueError: tp_size 8 must be divisible by ep_size 3` — на квантованных весах с `weight_block_size`.
- `'deepep' a2a backend requires expert parallelism (ep_size > 1).` — DeepEP выбран при `tp_size == 1`.
- Ранги видны в логе как ` EP<n>` (только при `ep_size > 1`), итоговое значение после всех переопределений — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --ep-size 8 --enable-dp-attention --dp-size 8 --moe-a2a-backend deepep
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --tensor-parallel-size 4 --ep-size 2 --moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/moe_ep_setup.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
