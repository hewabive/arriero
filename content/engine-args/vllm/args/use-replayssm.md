---
schema: 1
engine: vllm
primaryName: "--use-replayssm"
title: "--use-replayssm"
summary: Включает decode-kernel ReplaySSM для Mamba2: вместо записи полного состояния на каждом шаге движок копит входы в кольцевом буфере и сбрасывает чекпойнт раз в B шагов. Узко ограничен — только Nemotron-H, только Triton-backend, только обычный decode.
group: CacheConfig
related:
  - --replayssm-buffer-len
  - --mamba-cache-mode
  - --mamba-backend
  - --speculative-config
  - --kv-transfer-config
  - --mamba-block-size
  - --tensor-parallel-size
---

# --use-replayssm

## Кратко

В обычном decode mamba2-слой на каждом шаге читает и записывает полное ssm-состояние. ReplaySSM меняет размен: входы SSM за последние B шагов складываются в кольцевой буфер, а полное состояние переписывается в HBM только на флаше — раз в B шагов. Промежуточные шаги «доигрываются» из буфера.

Аргумент узко ограничен по применимости, и все ограничения проверяются на старте, а не в рантайме. Он платит памятью (три дополнительных тензора состояния на слой) за уменьшение трафика записи.

## Оригинальная справка

```text
Use the ReplaySSM Mamba2 decode kernel: cache recent SSM inputs and skip
the per-step full-state store, writing the checkpoint back only on flush.
Requires mamba_cache_mode 'none' or 'align' (prefix caching) and the Triton
mamba backend; standard (non-speculative) decode only. In align mode flushes
are most efficient when mamba_block_size is a multiple of replayssm_buffer_len,
but this is not required.
```

## Паспорт аргумента

- Флаги: `--use-replayssm`, `--no-use-replayssm`
- Группа argparse: `CacheConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения (`true`) либо парный `--no-use-replayssm` (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; вместо этого несовместимые конфигурации отклоняются валидатором `VllmConfig.validate_mamba_cached_kernel`
- Где объявлен: `vllm/config/cache.py:CacheConfig.use_replayssm`
- Этап применения: валидация `VllmConfig` → построение mamba-слоев (формы и типы состояния) → metadata builder mamba-backend'а → decode-kernel

## Что меняет в движке

**Проверки на старте** (`validate_mamba_cached_kernel`, все — `ValueError`):

- архитектура модели должна объявлять `supports_replayssm`: `--use-replayssm is only supported for Nemotron-H models (got architecture '<Arch>')`;
- `--mamba-cache-mode all` запрещен: `--use-replayssm supports prefix caching only in align mode; pass --mamba-cache-mode align`;
- спекулятивное декодирование запрещено: `--use-replayssm does not support speculative decoding`;
- mamba-backend обязан быть Triton: `--use-replayssm requires --mamba-backend triton`;
- KV-connector'ы запрещены: `--use-replayssm is incompatible with KV connectors (P/D disaggregation, KV cache offload)`.

Отдельная проверка живет в конструкторе `MambaMixer2`: `--use-replayssm requires tensor-parallel heads to divide evenly` — число голов должно делиться на размер TP-группы нацело.

**Состояние.** Обычно mamba-страница состоит из двух тензоров `(conv_state, ssm_state)`. При ReplaySSM их пять: `(conv_state, ssm_state, x_cache, dt_cache, B_cache)`. Формы кольца берутся из `MambaStateShapeCalculator.append_replayssm_ring` и зависят от `--replayssm-buffer-len`; типы — `(dtype активаций, float32, dtype активаций)`.

**Метаданные.** `Mamba2AttentionMetadataBuilder` при включенном флаге заводит CUDA-graph-буферы: позицию записи в кольце (`decode_write_pos_d`), флаг флаша (`decode_is_flush_d`) и fp32-скрэтч под предпосчет `kᵀq` (`decode_bc_pre_scratch`) размера `max(cudagraph_max_bs, max_num_seqs) × ngroups × replayssm_buffer_len`. Позиция вычисляется как `decode_steps % replayssm_buffer_len`, флаш — когда позиция равна `replayssm_buffer_len − 1`.

**Точка отсчета кольца.** `InputBatch` хранит `replayssm_decode_base` — полный контекст на момент (пере)допуска запроса, чтобы возобновленный запрос заново привязывал кольцо после промпта.

**Kernel.** В decode вместо `selective_state_update` вызывается `selective_state_update_replayssm_output_only` с кольцевыми тензорами, позицией записи и флагом флаша.

## Значения и формат

- `--use-replayssm` — включить.
- `--no-use-replayssm` — выключить (по умолчанию).
- Промежуточного состояния нет: «не задан» означает `false`.

## Когда использовать

- Только на Nemotron-H, с Triton-backend'ом mamba, без спекуляции и без KV-connector'ов — то есть в довольно узком, но вполне рабочем профиле: одиночный инстанс с decode-нагрузкой.
- Когда профиль показывает, что запись полного mamba-состояния на каждом шаге — заметная доля времени decode.
- В режиме `align` подберите `--mamba-block-size` кратным `--replayssm-buffer-len`: флаши тогда попадают на границы блоков. Справка отмечает, что это оптимизация, а не требование.
- **Не включайте** на других архитектурах: старт откажет с явным сообщением.
- Не включайте вместе с `--kv-offloading-size` или P/D-дизагрегацией: любые KV-connector'ы отклоняются валидатором.

## Влияние на производительность и память

- **VRAM.** Растет: mamba-страница расширяется с двух тензоров до пяти. Размер кольца пропорционален `--replayssm-buffer-len` и числу голов/групп на rank. Через размер mamba-страницы это может поднять `--block-size` в гибридной модели.
- **Трафик HBM.** Основной выигрыш: полное состояние пишется раз в B шагов вместо каждого.
- **Скрэтч.** Дополнительный fp32-буфер под предпосчет `kᵀq` на весь max-batch.
- **Prefill.** Не затрагивается; оптимизация относится к обычному decode.
- **CUDA graphs.** Кольцевые буферы статические и захватываются графами; спекулятивный decode-путь исключен по конструкции.

## Взаимодействие с другими аргументами

- `--replayssm-buffer-len`: длина кольца B; напрямую задает и период флаша, и размер дополнительных тензоров.
- `--mamba-cache-mode`: допустимы только `none` и `align`; `all` отклоняется.
- `--mamba-backend`: обязателен `triton`.
- `--speculative-config`: любая спекуляция с ненулевым числом draft-токенов отклоняется.
- `--kv-transfer-config` (и производный от `--kv-offloading-size`): несовместимы.
- `--mamba-block-size`: кратность `--replayssm-buffer-len` дает более эффективные флаши в режиме `align`.
- `--tensor-parallel-size`: число mamba-голов должно делиться на размер TP-группы нацело.

## Типовые проблемы и диагностика

- **Симптом:** `--use-replayssm is only supported for Nemotron-H models (got architecture '<Arch>')`. **Причина:** архитектура не объявляет `supports_replayssm`. **Лечение:** убрать флаг.
- **Симптом:** `--use-replayssm requires --mamba-backend triton`. **Причина:** выбран FlashInfer- или CPU-backend mamba. **Лечение:** `--mamba-backend triton`.
- **Симптом:** `--use-replayssm supports prefix caching only in align mode; pass --mamba-cache-mode align`. **Причина:** режим разрешился в `all`. **Лечение:** явный `--mamba-cache-mode align`.
- **Симптом:** `--use-replayssm requires tensor-parallel heads to divide evenly`. **Причина:** число mamba-голов не делится на `--tensor-parallel-size`. **Лечение:** сменить размер TP-группы.
- **Симптом:** `--use-replayssm does not support speculative decoding` или `--use-replayssm is incompatible with KV connectors (P/D disaggregation, KV cache offload)`. **Лечение:** отключить соответствующую подсистему.
- **Симптом:** VRAM под KV-cache упала после включения. **Причина:** mamba-страница выросла втрое по числу тензоров. **Проверка:** `GPU KV cache size: N tokens` до и после.
- **Симптом:** `--use-replayssm requires CPU decode-base and ...` в рантайме. **Причина:** метаданные decode-base не дошли до metadata builder'а. **Проверка:** `vllm/v1/attention/backends/mamba_attn.py`.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --use-replayssm --mamba-backend triton --enable-prefix-caching --mamba-cache-mode align
```

```bash
vllm serve /models/Nemotron-H-8B --use-replayssm --replayssm-buffer-len 32 --mamba-block-size 256 --enable-prefix-caching
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/mamba.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_utils.py`
- `vllm/vllm/model_executor/layers/mamba/ops/selective_state_update_replayssm_output_only.py`
- `vllm/vllm/model_executor/models/nemotron_h.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/v1/attention/backends/mamba_attn.py`
- `vllm/vllm/v1/worker/gpu_input_batch.py`
