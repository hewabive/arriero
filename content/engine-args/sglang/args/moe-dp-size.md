---
schema: 1
engine: sglang
primaryName: "--moe-dp-size"
title: "--moe-dp-size"
summary: Делит TP-группу на data-параллельные подгруппы для MoE-слоев, отбирая ранги у `moe_tp_size`. Используется вместе с контекстным параллелизмом внимания; вне этой связки обычно остается равным 1.
group: parallel
related:
  - --ep-size
  - --tp-size
  - --attn-cp-size
  - --pp-size
  - --moe-a2a-backend
  - --enable-prefill-cp
  - --cp-strategy
  - --moe-dense-tp-size
  - --elastic-ep-backend
  - --max-ep-size
---

# --moe-dp-size

## Кратко

`--moe-dp-size` вводит третью ось внутри той же TP-группы: `moe_tp_size = tp_size / ep_size / moe_dp_size`. Ранги, отданные под MoE-DP, обрабатывают **разные** токены одними и теми же весами экспертов, тогда как EP раскладывает по рангам сами веса, а MoE-TP режет каждого эксперта. Аргумент введен ради связки с контекстным параллелизмом внимания (`--attn-cp-size`): именно там появляется потребность в отдельной DP-оси у MoE. Значение по умолчанию `1` означает «MoE-DP выключен», и для подавляющего большинства конфигураций его менять не надо.

## Оригинальная справка

```text
The moe data parallelism size.
```

## Паспорт аргумента

- Флаги: `--moe-dp-size`, `--moe-data-parallel-size`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; делители `tp_size`, ограниченные соотношениями ниже
- Значение по умолчанию: `1`
- Эффективное значение: переписывается только в `_handle_dwdp` — при `--dwdp-size > 1` принудительно ставится `moe_dp_size = 1`. В остальных случаях действует заданное значение
- Где объявлен: `ServerArgs.moe_dp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_context_parallelism` — все проверки делимости; `_handle_elastic_ep`) → `initialize_model_parallel(moe_data_model_parallel_size=…)` → forward MoE-слоя

## Что меняет в движке

Значение доходит до `initialize_model_parallel` (`distributed/parallel_state.py`) и определяет разбиение TP-группы на четыре согласованные оси. Docstring функции дает каноническую раскладку для восьми карт при `tp_size=4` (две TP-группы), `attn_cp_size=2`, `moe_dp_size=2`, `moe_ep_size=4`:

```
2 tensor model-parallel groups:  [g0,g1,g2,g3] [g4,g5,g6,g7]
4 attention context-parallel:    [g0,g4] [g1,g5] [g2,g6] [g3,g7]
2 moe expert-parallel groups:    [g0,g1,g2,g3] [g4,g5,g6,g7]
4 moe data-parallel groups:      [g0,g4] [g1,g5] [g2,g6] [g3,g7]
```

Группа `_MOE_DP` выбирается по трем веткам:

- `attn_cp_size > moe_dp_size` → `_MOE_DP = _ATTN_CP` (CP-партнеры обязаны обменяться токенами до MoE, и существующий DP allgather/scatter это делает);
- `moe_dp_size == tp_size` → `_MOE_DP = _TP`;
- иначе строится отдельный коммуникатор с шагом `moe_tp_size * moe_ep_size`.

Ранг считается как `moe_dp_rank = tp_rank // (tp_size // moe_dp_size)`; при `moe_dp_size > 1` в префикс строк лога добавляется ` MOE_DP<rank>`.

## Значения и формат

- Целое ≥ 1. `1` — ось выключена, и почти все связанные проверки не выполняются.
- При `moe_dp_size > 1` (`_handle_context_parallelism`):
  - `tp_size % moe_dp_size == 0`;
  - `ep_size * moe_dp_size <= tp_size`, а при `ep_size > 1` — строгое `ep_size * moe_dp_size == tp_size`;
  - `pp_size == 1` (`PP is not supported with context parallelism`);
  - `--enable-aiter-allreduce-fusion` запрещен.
- Отдельно и всегда: `attn_cp_size != moe_dp_size` допускается только при `moe_dp_size == 1`. То есть если вы включили `--attn-cp-size 2`, у вас либо `moe_dp_size == 1`, либо `moe_dp_size == 2` — промежуточных вариантов нет.

## Когда использовать

- Вместе с контекстным параллелизмом внимания, когда нужно, чтобы MoE не повторял CP-раскладку: это единственный сценарий, для которого ось введена и в котором она проверена кодом.
- Не включайте «для симметрии» с `--dp-size`: это разные вещи. `--dp-size` (с DP-attention) делит внимание, `--moe-dp-size` делит MoE, и включение второго без первого просто отберет ранги у `moe_tp_size`.
- Не включайте вместе с `--pp-size > 1` и вместе с elastic EP scale-up — оба режима требуют `moe_dp_size == 1`.

## Влияние на производительность и память

- **VRAM.** Уменьшение `moe_tp_size` означает более крупные куски эксперта на ранг: при том же `ep_size` веса экспертов на ранге растут в `moe_dp_size` раз. Это плата за уменьшение коммуникации.
- **Коммуникация.** Токены между MoE-DP-группами не ездят: каждая группа считает свои. Вместо этого добавляется gather/scatter на границе с вниманием, если раскладка осей не совпадает.
- **GEMM.** Более крупный `intermediate_size_per_partition` обычно эффективнее для ядер; обратная сторона — `assert intermediate_size % moe_tp_size == 0` становится легче выполнить, но память на ранг растет.
- **KV-кеш.** Не затрагивается.
- Собственных буферов аргумент не выделяет: вся стоимость — через перераспределение осей.

## Взаимодействие с другими аргументами

- `--ep-size`: жесткое `ep_size * moe_dp_size == tp_size` при обоих `> 1`.
- `--tp-size`: делимость `tp_size % moe_dp_size == 0`.
- `--attn-cp-size`: либо равен `moe_dp_size`, либо `moe_dp_size` обязан быть `1`; при `attn_cp_size > moe_dp_size` группа MoE-DP подменяется группой CP.
- `--pp-size`: обязан быть `1`.
- `--enable-prefill-cp` / `--cp-strategy`: основной контекст применения этой оси.
- `--dwdp-size`: обнуляет ось (`moe_dp_size = 1`).
- `--elastic-ep-backend` + `--max-ep-size` (scale-up): требует `moe_dp_size == 1`.
- `--moe-dense-tp-size`: другая ручка того же MoE-слоя, но про плотные MLP, а не про экспертов.

## Типовые проблемы и диагностика

- `AssertionError: tp_size must be divisible by moe_dp_size` — нарушена делимость.
- `AssertionError: ep_size * moe_dp_size must be equal to tp_size` — при `ep_size > 1` требуется точное равенство, `<=` недостаточно.
- `AssertionError: attn_cp_size != moe_dp_size is only supported when moe_dp_size == 1` — оси CP и MoE-DP разошлись.
- `AssertionError: PP is not supported with context parallelism` — вместе с `--pp-size > 1`.
- `AssertionError: Elastic EP scale-up requires --moe-dp-size 1 (got moe_dp_size=N).`
- `AssertionError: Aiter allreduce fusion is not supported with context parallelism` — уберите `--enable-aiter-allreduce-fusion`.
- Подтверждение: префикс ` MOE_DP<n>` в строках лога (появляется только при значении `> 1`) и дамп `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --moe-dp-size 2 --ep-size 4 --attn-cp-size 2 --dp-size 1
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --tensor-parallel-size 4 --moe-dp-size 1 --ep-size 4 --moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/moe_ep_setup.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
