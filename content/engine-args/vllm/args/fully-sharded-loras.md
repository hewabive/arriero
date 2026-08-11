---
schema: 1
engine: vllm
primaryName: "--fully-sharded-loras"
title: "--fully-sharded-loras"
summary: Переключает LoRA-слои на S-LoRA-вариант, где шардируется обе матрицы разложения, а не одна. Имеет смысл только при tensor parallel > 1: экономит VRAM на слотах ценой дополнительной коллективной операции в каждом LoRA-слое.
group: LoRAConfig
related:
  - --enable-lora
  - --tensor-parallel-size
  - --max-lora-rank
  - --max-loras
  - --enable-expert-parallel
  - --lora-target-modules
---

# --fully-sharded-loras

## Кратко

По умолчанию при TP > 1 шардируется только «половина» LoRA-вычисления: у column-parallel слоёв делится по рангам матрица `B`, у row-parallel — матрица `A`, а вторая матрица реплицируется на каждом ранге целиком. С этим флагом делятся обе, по схеме S-LoRA.

Практический эффект двойной: буферы слотов на каждом устройстве становятся меньше, но в forward каждого LoRA-слоя появляется дополнительная коллективная операция — `all_gather` промежуточного буфера для column-parallel и `all_reduce` для row-parallel.

## Оригинальная справка

```text
By default, only half of the LoRA computation is sharded with tensor
parallelism. Enabling this will use the fully sharded layers. At high
sequence length, max rank or tensor parallel size, this is likely faster.
```

## Паспорт аргумента

- Флаги: `--fully-sharded-loras`, `--no-fully-sharded-loras`
- Группа argparse: `LoRAConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: сам флаг не переопределяется, но при `VLLM_LORA_ENABLE_DUAL_STREAM=1` валидатор `LoRAConfig._validate_lora_config` печатает предупреждение и **сбрасывает переменную окружения** в `False`, то есть выигрывает `--fully-sharded-loras`. Кроме того, при `tensor_parallel_size == 1` часть слоёв (например, `MergedColumnParallelLinear`) остаётся на нешардированной обёртке
- Где объявлен: `vllm/config/lora.py:LoRAConfig.fully_sharded_loras`
- Этап применения: загрузка модели (выбор класса обёртки и форм буферов) → forward

## Что меняет в движке

**Выбор класса обёртки.** Каждая LoRA-обёртка объявляет `can_replace_layer()` с декоратором: `_not_fully_sharded_can_replace` для обычных классов и `_fully_sharded_can_replace` для `*WithShardedLoRA`. Флаг просто определяет, какая половина набора классов подойдёт: `ColumnParallelLinearWithShardedLoRA`, `MergedColumnParallelLinearWithShardedLoRA`, `QKVParallelLinearWithShardedLoRA`, `MergedQKVParallelLinearWithShardedLoRA`, `RowParallelLinearWithShardedLoRA`.

**Формы буферов.** В `create_lora_weights()`:

- column-parallel: `lora_a_out_size = divide(max_lora_rank, tp_size)` вместо `max_lora_rank`;
- row-parallel: `lora_b_out_size = divide(output_size, tp_size)` вместо `output_size`;
- MoE: `w13_lora_a_stacked` получает `divide(max_lora_rank, tp_size)`, `w2_lora_b_stacked` — `divide(hidden_size, tp_size)`.

`divide()` требует **точной** делимости и падает иначе — это единственный способ получить отказ старта из-за этого флага.

**Forward.** `_mcp_apply()` для column-parallel слоёв выделяет промежуточный `float32`-буфер `(n_slices, tokens, local_rank)`, делает shrink, затем `tensor_model_parallel_all_gather(buffers)` и expand. `RowParallelLinearWithShardedLoRA.apply()` делает shrink, `tensor_model_parallel_all_reduce(buffer)` и expand со смещением по рангу; итоговый выход — частичная сумма, которую доредуцирует штатный all-reduce row-parallel слоя.

**Прогрев.** Для полностью шардированных MoE-обёрток ранг фиктивного адаптера округляется вверх до НОК размеров TP-групп (`get_dummy_lora_warmup_rank`). Если округлённое значение превысит `max_lora_rank`, старт падает с `Unable to choose a dummy LoRA warmup rank compatible with fully sharded MoE modules: ...`.

## Значения и формат

- Значение по умолчанию `false`. Не задан и `--no-fully-sharded-loras` эквивалентны.
- При `--tensor-parallel-size 1` включение почти бесполезно: делить не на что, а часть слоёв всё равно берёт нешардированный класс.
- Значение входит в `LoRAConfig.compute_hash()`, поэтому переключение инвалидирует кэш компиляции.

## Когда использовать

- Заявленная область выгоды из справки: большой `--max-lora-rank`, длинные последовательности, большой `--tensor-parallel-size`. Проверять надо замером: выигрыш от меньших буферов и меньшего объёма умножений конкурирует с дополнительной коллективной операцией на каждый LoRA-слой.
- Нужна VRAM: при TP 4 и ранге 128 столбцовые буферы `A` уменьшаются вчетверо, строковые буферы `B` — тоже.
- Не включайте при `--tensor-parallel-size 1`.
- Не включайте вместе с `--enable-expert-parallel` на MoE-модели с LoRA: комбинация запрещена явным assert.

## Влияние на производительность и память

- **VRAM.** Снижает размер слотов на каждом устройстве: обе матрицы разложения делятся между рангами TP, вместо репликации одной из них.
- **RAM хоста.** Не влияет: на CPU лежат полные веса адаптера, срез делается при копировании в слот (`slice_lora_a`/`slice_lora_b`).
- **Время старта.** Практически не меняется; риск — отказ по делимости.
- **Throughput и latency.** Добавляется по одной коллективной операции на LoRA-слой (`all_gather` или `all_reduce` промежуточного `float32`-буфера размером `n_slices × tokens × local_rank`). На коротких батчах это чистые накладные расходы; на длинных последовательностях и высоких рангах экономия на умножениях начинает окупать обмен.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`: делитель во всех формулах; при `1` флаг фактически бездействует.
- `--max-lora-rank`: должен делиться на `tensor_parallel_size` — иначе отказ старта при выделении column-parallel буферов.
- `--max-loras`: размер слота уменьшается, число слотов — нет.
- `--enable-expert-parallel`: несовместим на MoE-моделях с LoRA (`Fused MoE LoRA does not support enable_expert_parallel=True together with fully_sharded_loras=True. Disable one of them.`).
- `--lora-target-modules`: определяет, к каким слоям всё это применяется.

## Типовые проблемы и диагностика

- **Симптом:** старт падает на ошибке делимости при создании LoRA-весов. **Причина:** `max_lora_rank` (или `output_size` row-parallel слоя) не делится на `tensor_parallel_size`. **Лечение:** выбрать ранг, кратный TP, либо снять флаг.
- **Симптом:** `AssertionError: Fused MoE LoRA does not support enable_expert_parallel=True together with fully_sharded_loras=True. Disable one of them.` **Причина:** EP и полное шардирование делят одну и ту же TP-группу по разным осям. **Лечение:** отключить одно из двух.
- **Симптом:** `ValueError: Unable to choose a dummy LoRA warmup rank compatible with fully sharded MoE modules: ...` **Причина:** ранг прогрева, округлённый до НОК TP-размеров MoE-обёрток, превысил `max_lora_rank`. **Лечение:** поднять `--max-lora-rank` до подходящего значения из списка или снять флаг.
- **Симптом:** в логе `fully_sharded_loras isn't compatible with VLLM_LORA_ENABLE_DUAL_STREAM, set VLLM_LORA_ENABLE_DUAL_STREAM=False`. **Причина:** заданы обе оптимизации. **Лечение:** ничего чинить не надо — движок сам отключил dual-stream; если нужен именно он, снимите флаг.
- **Симптом:** после включения флага throughput упал. **Причина:** накладные расходы коллективов превысили выигрыш на данном профиле нагрузки. **Лечение:** вернуть `--no-fully-sharded-loras`.

## Примеры

```bash
vllm serve /models/Qwen3-32B --enable-lora --fully-sharded-loras --tensor-parallel-size 4 --max-lora-rank 128
```

```bash
vllm serve /models/Qwen3-32B --enable-lora --no-fully-sharded-loras --tensor-parallel-size 4 --max-lora-rank 16
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/lora/layers/utils.py`
- `vllm/vllm/lora/layers/base_linear.py`
- `vllm/vllm/lora/layers/column_parallel_linear.py`
- `vllm/vllm/lora/layers/row_parallel_linear.py`
- `vllm/vllm/lora/layers/fused_moe.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/docs/features/lora.md`
