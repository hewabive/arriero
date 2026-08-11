---
schema: 1
engine: sglang
primaryName: "--attn-cp-size"
title: "--attn-cp-size"
summary: Размер группы context parallelism внутри TP-группы: на сколько рангов режется одна последовательность. Для моделей DeepSeek при включенном prefill-CP выставляется автоматически как `tp_size // dp_size`.
group: parallel
related:
  - --enable-prefill-cp
  - --cp-strategy
  - --enable-cp-decode-attn-tp
  - --enable-dsa-cache-layer-split
  - --tp-size
  - --dp-size
  - --moe-dp-size
  - --enable-dp-attention
  - --dcp-size
  - --enable-aiter-allreduce-fusion
  - --prefill-only-disable-kv-cache
---

# --attn-cp-size

## Кратко

`--attn-cp-size` делит TP-группу еще раз: `attn_tp_size = tp_size // dp_size // attn_cp_size`. Ранги одной CP-группы работают над разными частями одной последовательности, а `attn_tp_size` — сколько рангов при этом еще и делят головы внимания. Аргумент почти никогда не задают вручную: для семейства DeepSeek с `--enable-prefill-cp` он подставляется автоматически как `tp_size // dp_size`, а вне CP значение `1` — единственно осмысленное. Значение `> 1` при выключенном `--enable-prefill-cp` создаст CP-группу, но стратегия не будет создана, и разрезания последовательности не произойдет.

## Оригинальная справка

```text
The attention context parallelism size.
```

## Паспорт аргумента

- Флаги: `--attn-cp-size`, `--attention-context-parallel-size`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; должно делить `tp_size` и `tp_size / dp_size` (проверяется ассертами)
- Значение по умолчанию: `1`
- Эффективное значение: поле объявлено `resolvable=True`, то есть модельные override'ы имеют право его переписать. `_deepseek_family_overrides` при `--enable-prefill-cp` ставит `attn_cp_size = tp_size // dp_size` и для DSA-, и для MLA-ветки; `deepseek_v4_hook` делает то же самое для DeepSeek-V4. Эффективное значение читается через `self._resolved()`, поэтому в ассертах и в расчете рангов участвует именно оно, а не то, что стояло в командной строке
- Где объявлен: `ServerArgs.attn_cp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (модельные override'ы → `_handle_context_parallelism` → `init_cp_strategy`) → `initialize_model_parallel` (создание группы `ATTN_CP`) → forward

## Что меняет в движке

### Группы и ранги

`initialize_model_parallel` (`sglang/python/sglang/srt/distributed/parallel_state.py`) считает

```python
attn_tp_size = tensor_model_parallel_size // attn_cp_size // attn_dp_size
```

и создает группу `_ATTN_CP`; при `attn_cp_size == tp_size` она совпадает с TP-группой целиком. Ранг внутри группы вычисляется как `attn_cp_rank = (tp_rank // attn_tp_size) % attn_cp_size` (`managers/data_parallel_controller.py`, тот же расчет в `entrypoints/engine.py`). Иерархия параллелизмов, зафиксированная в комментарии кода: `Global(TP) → DP → ATTN_CP → ATTN_TP`.

При `attn_cp_size > 1` в префикс строк лога и в имя процесса добавляется ` ATTN_CP<rank>` — это самый быстрый способ убедиться, что группа действительно создана.

### Проверки делимости

`_handle_context_parallelism`:

```text
assert tp_size % attn_cp_size == 0            -> "tp_size must be divisible by attn_cp_size"
assert tp_size % (dp_size * attn_cp_size) == 0 -> "tp_size must be divisible by dp_size * attn_cp_size"
assert not enable_aiter_allreduce_fusion       -> "Aiter allreduce fusion is not supported with context parallelism"
```

Плюс отдельное правило совместимости с MoE-DP: `attn_cp_size != moe_dp_size` разрешено только при `moe_dp_size == 1`.

### Синхронизация планировщика

При `attn_cp_size > 1` scheduler добавляет широковещание служебных данных по CP-группе (`broadcast_pyobj(..., self.attn_cp_cpu_group, ...)` в `managers/scheduler_pp_mixin.py`) — то есть длины последовательностей и метаданные батча согласуются между CP-рангами так же, как между attn-TP-рангами.

### Влияние на память и графы

- KV-кеш: размер ячейки считается от `attn_tp_size` (`model_config.get_num_kv_heads(attn_tp_size, attn_dcp_size)`). Увеличение `attn_cp_size` **уменьшает** `attn_tp_size`, то есть на каждый ранг приходится больше KV-голов и ячейка становится больше. Ожидать от CP уменьшения KV-пула не следует — на фазе prefill K/V к тому же реплицируются all-gather'ом.
- Захват CUDA graph на prefill отключается: `attn_cp_size > 1` входит в список несовместимостей и для обычного, и для breakable-графа (последний остается доступен только при выполнении условий `supports_prefill_cp_bcg`).
- Для DSA-путей с включенным CP `attn_tp_size` намеренно удерживается равным 1: `DSACPLayerCommunicator` не делает all-reduce частичных выходов `o_proj` перед реплицированными dense-FFN.

## Значения и формат

- Целое ≥ 1. `1` — «context parallelism выключен», а не «авто».
- Должно делить `tp_size` и `tp_size / dp_size`.
- Верхний практический предел — `tp_size` (тогда CP-группа совпадает с TP-группой).
- Значение `> 1` без `--enable-prefill-cp` создаст группу и изменит `attn_tp_size`, но стратегии разрезания не будет: `init_cp_strategy` требует включенного prefill-CP. Это рабочая, но почти всегда ошибочная конфигурация.
- На Ascend-платформе апстрим требует `attn_cp_size == tp_size`.

## Когда использовать

- Задавать вручную имеет смысл на моделях **вне** семейства DeepSeek, где автоматических override'ов нет, а нужен prefill-CP.
- На DeepSeek/DSA — оставьте значение по умолчанию и включите `--enable-prefill-cp`: движок подберет `tp_size // dp_size` сам и напечатает это предупреждением.
- Не поднимать «для экономии VRAM»: KV-ячейка на ранг от этого растет, а не падает.
- Не сочетать с `--enable-aiter-allreduce-fusion` — прямой запрет.
- Не задавать без `--enable-prefill-cp`.

## Влияние на производительность и память

- Время prefill: главный выигрыш — квадратичная по длине работа внимания делится на `attn_cp_size`.
- VRAM: KV-ячейка на ранг растет (меньше `attn_tp_size` — больше KV-голов на ранг); пиковые буферы внимания при этом уменьшаются.
- Коммуникация: на каждый слой добавляется сбор K/V и выходов внимания по CP-группе; плюс широковещание метаданных батча в планировщике.
- CUDA graph: prefill-граф выключается, что удлиняет prefill на коротких запросах.
- Decode: без `--enable-cp-decode-attn-tp` линейные слои внимания реплицированы, и каждый CP-ранг считает одни и те же GEMM.

## Взаимодействие с другими аргументами

- `--tp-size`: делимое; `tp_size % attn_cp_size == 0` обязательно.
- `--dp-size` / `--enable-dp-attention`: `attn_tp_size = tp_size // dp_size // attn_cp_size`; требуется `tp_size % (dp_size * attn_cp_size) == 0`.
- `--enable-prefill-cp` / `--cp-strategy`: без них группа создается, а разрезание — нет.
- `--moe-dp-size`: `attn_cp_size != moe_dp_size` допустимо только при `moe_dp_size == 1`.
- `--enable-cp-decode-attn-tp`: использует `attn_cp_rank` / `attn_cp_size` как TP-разбиение для decode.
- `--dcp-size`: независимый механизм для фазы decode; их размеры не связаны.
- `--enable-aiter-allreduce-fusion`: несовместим.
- `--prefill-only-disable-kv-cache`: несовместим при `attn_cp_size > 1`.

## Типовые проблемы и диагностика

- `AssertionError: tp_size must be divisible by attn_cp_size` / `tp_size must be divisible by dp_size * attn_cp_size` — неверная делимость.
- `AssertionError: Aiter allreduce fusion is not supported with context parallelism`.
- `AssertionError: attn_cp_size != moe_dp_size is only supported when moe_dp_size == 1`.
- `ValueError: --prefill-only-disable-kv-cache is incompatible with --attn-cp-size > 1: the context-parallel attention path writes K/V to the pool via set_kv_buffer, which the no-op pool intentionally rejects.`
- Задал `--attn-cp-size 4`, а группы нет — смотрите префикс ` ATTN_CP<rank>` в строках лога: без него группа не создана (например, значение переписано override'ом).
- `max_total_num_tokens` уменьшился после включения CP — прямое следствие роста KV-ячейки на ранг; компенсируется `--mem-fraction-static` или `--enable-dsa-cache-layer-split` там, где он применим.
- Что смотреть в логе: `attn_cp_size=` в дампе `server_args=`; предупреждения `Enabled DSA context parallel: … attn_cp_size=…` и `Enable Context Parallel opt for MLA, … attn_cp_size == …`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --attention-context-parallel-size 8
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 2 --enable-dp-attention --enable-prefill-cp --cp-strategy zigzag --attention-context-parallel-size 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/managers/scheduler_pp_mixin.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/docs/docs/hardware-platforms/ascend-npus/optimization/parameter_tuning.mdx`
