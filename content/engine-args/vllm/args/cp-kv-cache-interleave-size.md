---
schema: 1
engine: vllm
primaryName: "--cp-kv-cache-interleave-size"
title: "--cp-kv-cache-interleave-size"
summary: Гранулярность чередования токенов KV-cache между DCP-рангами: сколько подряд идущих токенов ложится на один ранг, прежде чем очередь переходит к следующему. Значим только при `--decode-context-parallel-size` больше единицы.
group: ParallelConfig
related:
  - --decode-context-parallel-size
  - --dcp-kv-cache-interleave-size
  - --dcp-comm-backend
  - --block-size
  - --tensor-parallel-size
  - --attention-backend
  - --enable-prefix-caching
---

# --cp-kv-cache-interleave-size

## Кратко

DCP разрезает KV-cache вдоль оси токенов. Этот флаг задаёт шаг разрезания: `1` — чередование по одному токену (`token i` → `dcp_rank i % dcp_world_size`), значение, равное размеру блока, — чередование по целым блокам.

Флаг нужен вместе с `--decode-context-parallel-size > 1`; без DCP он не читается и не проверяется.

## Оригинальная справка

```text
Interleave size of kv_cache storage while using DCP.
Store interleave_size tokens on dcp_rank i, then store next
interleave_size tokens on dcp_rank i+1.
Interleave_size=1: token-level alignment, where token `i` is stored on
    dcp_rank `i % dcp_world_size`.
Interleave_size=block_size: block-level alignment, where tokens are
    first populated to the preceding ranks. Tokens are then stored
    in (rank i+1, block j) only after (rank i, block j) is fully occupied.
Block_size should be greater than or equal to cp_kv_cache_interleave_size.
Block_size should be divisible by cp_kv_cache_interleave_size.
```

## Паспорт аргумента

- Флаги: `--cp-kv-cache-interleave-size`
- Группа argparse: `ParallelConfig`
- Тип значения: int (токены)
- Допустимые значения: не ограничены списком; при DCP > 1 проверяется `cp_kv_cache_interleave_size ≤ block_size` и `block_size % cp_kv_cache_interleave_size == 0`
- Значение по умолчанию: `1` (объявлено обычным `int = 1`, без `Field`, поэтому дополнительных pydantic-границ нет)
- Эффективное значение: при DCP > 1 и `--dcp-kv-cache-interleave-size > 1` значение **перезаписывается** устаревшим флагом с предупреждением `cp_kv_cache_interleave_size is overridden by dcp_kv_cache_interleave_size. And dcp-kv-cache-interleave-size will be deprecated when PCP is fully supported.`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.cp_kv_cache_interleave_size`
- Этап применения: `VllmConfig.validate_block_size()` (уже после того, как платформа зафиксировала `block_size` под выбранный attention-бэкенд) → раскладка KV-cache → метаданные внимания на каждом шаге

## Что меняет в движке

Значение определяет, какой кусок последовательности хранит каждый DCP-ранг. Из него считается локальная длина последовательности на ранге (`get_dcp_local_seq_lens` в `vllm/v1/attention/backends/utils.py`):

```text
base      = seq_len // interleave // dcp_size * interleave
remainder = clip(seq_len - base * dcp_size - rank * interleave, 0, interleave)
local_len = base + remainder
```

Оттуда значение расходится по путям внимания:

- `mla_attention.py` — `dcp_local_block_size = cp_kv_cache_interleave_size`, число партиций `dcp_world_size × cp_kv_cache_interleave_size`, выравнивание рабочей области chunked-prefill по `lcm(block_size, dcp × interleave)`;
- `flash_attn.py` — та же арифметика партиций для GQA-пути;
- `sparse_attn_indexer.py` и `sparse_mla_attention.py` — раскладка для разреженного внимания;
- `kv_transfer/.../canonical_mapping.py` — каноническое отображение при выгрузке KV.

Проверка совместимости с размером блока живёт в `VllmConfig.validate_block_size()` и выполняется только при `decode_context_parallel_size > 1`.

## Значения и формат

- Целое `≥ 1`, не больше `--block-size` и делящее его нацело.
- `1` — самое мелкое чередование: соседние токены расходятся по разным рангам. Нагрузка распределяется максимально равномерно даже на коротких последовательностях.
- Значение, равное размеру блока, — блочное выравнивание: ранг `i+1` начинает получать токены блока `j` только после того, как заполнен блок `j` ранга `i`.
- Проверка идёт против **эффективного** `block_size`, который платформа могла изменить под выбранный attention-бэкенд (`update_block_size_for_backend`), а не против того, что вы передали в `--block-size`.

## Когда использовать

- Оставить `1`, если нет конкретной причины менять: это самая равномерная раскладка.
- Увеличивать до размера блока, когда нужна блочная локальность — например, ради связности доступа в бэкенде внимания или ради совместимости с внешней выгрузкой KV.
- Не задавать без `--decode-context-parallel-size > 1`: значение не будет ни прочитано, ни проверено.
- Не задавать одновременно с `--dcp-kv-cache-interleave-size`: устаревший флаг перебьёт этот.

## Влияние на производительность и память

- **VRAM.** Общий объём KV-cache не меняется — меняется только распределение токенов по рангам. Но при крупной грануле короткая последовательность может целиком лечь на один ранг, и остальные ранги для неё не разгрузятся.
- **Latency.** Влияет на шаблон доступа к памяти в ядрах внимания и на выравнивание рабочей области chunked-prefill (для MLA — `lcm(block_size, dcp × interleave)`, то есть крупная гранула увеличивает выравнивание и, следовательно, минимальный размер рабочей области).
- **Балансировка.** Мелкая гранула выравнивает длины локальных последовательностей между рангами, крупная — допускает перекос на коротких контекстах.

## Взаимодействие с другими аргументами

- `--decode-context-parallel-size`: без него флаг инертен.
- `--block-size`: жёсткая связь — `interleave ≤ block_size` и `block_size % interleave == 0`.
- `--dcp-kv-cache-interleave-size`: устаревший дубль, который при значении больше 1 перезаписывает этот флаг.
- `--dcp-comm-backend`: определяет, как объединяются частичные результаты, посчитанные по этой раскладке.
- `--attention-backend`: через него платформа выбирает фактический `block_size`, против которого идёт проверка.
- `--enable-prefix-caching`: при DCP частичные попадания и так отключены, а эффективный размер блока умножается на `dcp`.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Block_size(16) should be greater than or equal to and divisible by cp_kv_cache_interleave_size (64).` **Причина:** гранула больше фактического размера блока или не делит его. **Лечение:** уменьшить значение либо поднять `--block-size` (учитывая, что бэкенд внимания может его переопределить).
- **Симптом:** заданное значение не применилось. **Причина:** предупреждение `cp_kv_cache_interleave_size is overridden by dcp_kv_cache_interleave_size.` — задан устаревший флаг. **Лечение:** убрать `--dcp-kv-cache-interleave-size`.
- **Симптом:** флаг задан, но ничего не изменилось. **Причина:** `--decode-context-parallel-size` равен 1, проверка и раскладка не выполняются. **Лечение:** включить DCP.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `cp_kv_cache_interleave_size=...` рядом с `decode_context_parallel_size=...`.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 8 --cp-kv-cache-interleave-size 1
```

```bash
vllm serve /models/DeepSeek-V2-Lite --tensor-parallel-size 8 --decode-context-parallel-size 8 --block-size 64 --cp-kv-cache-interleave-size 64
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/attention/backends/utils.py`
- `vllm/vllm/v1/attention/backends/flash_attn.py`
- `vllm/vllm/model_executor/layers/attention/mla_attention.py`
- `vllm/vllm/model_executor/layers/sparse_attn_indexer.py`
- `vllm/docs/serving/context_parallel_deployment.md`
