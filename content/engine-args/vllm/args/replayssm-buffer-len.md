---
schema: 1
engine: vllm
primaryName: "--replayssm-buffer-len"
title: "--replayssm-buffer-len"
summary: Длина кольцевого буфера ReplaySSM в шагах decode: раз в столько шагов полное состояние сбрасывается в HBM. Читается только при --use-replayssm и прямо задает размер трех дополнительных тензоров состояния.
group: CacheConfig
related:
  - --use-replayssm
  - --mamba-block-size
  - --mamba-cache-mode
  - --max-num-seqs
  - --mamba-backend
---

# --replayssm-buffer-len

## Кратко

`--replayssm-buffer-len` — это B из механики ReplaySSM: входы SSM за последние B шагов decode лежат в кольцевом буфере, а полное состояние переписывается в HBM только когда кольцо заполнилось.

Аргумент читается **только** при `--use-replayssm`: без него `MambaMixer2` подставляет `None` и кольцо не создается. Значение — не просто период флаша: оно линейно задает размер трех дополнительных тензоров mamba-состояния и fp32-скрэтча метаданных.

## Оригинальная справка

```text
ReplaySSM history buffer length B for standard Mamba2 decode. Kimi-K3
speculative decoding does not use B. Default 16.
```

Справка сокращена в PR #51855, добавившем Kimi-K3 RecoverSSM: спекулятивный decode KDA-слоев Kimi-K3 (`CacheConfig.use_kda_recoverssm`, выставляется движком в `VllmConfig.__post_init__` при активной спекулятивной конфигурации, не через CLI) идет отдельным путём и кольцевой буфер B не использует. Для стандартного (неспекулятивного) Mamba2 decode механика ниже не изменилась.

## Паспорт аргумента

- Флаги: `--replayssm-buffer-len`
- Группа argparse: `CacheConfig`
- Тип значения: int (число шагов decode)
- Допустимые значения: целые больше нуля (валидация `gt=0`)
- Значение по умолчанию: `Field(default=16, gt=0)`, то есть `16` при ограничении «строго больше нуля»
- Эффективное значение: не переопределяется, но игнорируется, если `--use-replayssm` не задан
- Где объявлен: `vllm/config/cache.py:CacheConfig.replayssm_buffer_len`
- Этап применения: построение mamba-слоев (формы состояния) → metadata builder mamba-backend'а → decode-kernel

## Что меняет в движке

**Формы состояния.** `MambaStateShapeCalculator.append_replayssm_ring` добавляет к базовой паре `(conv_state, ssm_state)` три тензора, у всех трех B — одна из размерностей:

```
x_cache : (nheads/tp, B, head_dim)
dt_cache: (nheads/tp, B)
B_cache : (ngroups/tp, B, state_size)
```

Их типы — `(dtype активаций, float32, dtype активаций)`. Всё это входит в mamba-страницу, поэтому B напрямую влияет на `MambaSpec.page_size_bytes`, а через него — на выравнивание с attention-страницей и на итоговый `--block-size` в гибридных моделях.

**Метаданные и CUDA graphs.** `Mamba2AttentionMetadataBuilder` аллоцирует fp32-скрэтч `decode_bc_pre_scratch` формы `(max(cudagraph_max_bs, max_num_seqs), ngroups, replayssm_buffer_len)` под предпосчитанные произведения `kᵀq`. Это отдельная от состояния память, растущая одновременно по B и по числу одновременных последовательностей.

**Период флаша.** На каждом шаге считается `write_pos = decode_steps % replayssm_buffer_len`, а флаг флаша — `write_pos == replayssm_buffer_len − 1`. То есть полное состояние пишется ровно раз в B шагов. Отсчет `decode_steps` ведется от `replayssm_decode_base` — полного контекста на момент допуска запроса, поэтому возобновленный запрос заново привязывает кольцо после промпта.

**Kernel.** Значение передается в `selective_state_update_replayssm_output_only` как `max_cache_len`.

## Значения и формат

- Целое число шагов decode, минимум 1.
- `1` формально допустимо, но вырождает механизм: флаш происходит каждый шаг, а память под кольцо все равно тратится.
- Дефолт `16`. Более крупные значения (32, 64) реже пишут состояние, но пропорционально увеличивают кольцо и скрэтч.
- Верхней границы нет; практическая граница — доступная память и длина типичной генерации: если ответы короче B шагов, флаш может не наступить ни разу за запрос.

## Когда использовать

- Увеличивать, когда включен `--use-replayssm` и вы хотите уменьшить частоту записи полного состояния, а память под mamba-страницу есть.
- В режиме `--mamba-cache-mode align` подбирайте `--mamba-block-size` кратным этому значению: тогда флаши совпадают с границами блоков. Справка `--use-replayssm` отмечает, что это оптимизация, а не требование.
- Не трогайте без `--use-replayssm`: значение просто не будет прочитано.
- Не увеличивайте вслепую при большом `--max-num-seqs`: скрэтч метаданных растет как произведение B на число одновременных последовательностей.

## Влияние на производительность и память

- **VRAM (состояние).** Три кольцевых тензора на каждый mamba-слой, линейно по B.
- **VRAM (скрэтч).** `max(cudagraph_max_bs, max_num_seqs) × ngroups × B` значений fp32 — отдельная аллокация, не входящая в KV-cache.
- **Трафик HBM.** Запись полного состояния — раз в B шагов вместо каждого. Это цель механизма.
- **Гранулярность блоков.** Через размер mamba-страницы значение может поднять `--block-size` и ухудшить гранулярность prefix caching.
- **Prefill.** Не затрагивается.

## Взаимодействие с другими аргументами

- `--use-replayssm`: обязательное условие; без него аргумент инертен.
- `--mamba-block-size`: кратность даёт совпадение флашей с границами блоков в режиме `align`.
- `--mamba-cache-mode`: сочетание с `align` — единственный режим, где кратность вообще имеет смысл; `all` с ReplaySSM запрещен.
- `--max-num-seqs`: множитель для fp32-скрэтча метаданных.
- `--mamba-backend`: механизм работает только с Triton-backend'ом.

## Типовые проблемы и диагностика

- **Симптом:** значение задано, ничего не изменилось. **Причина:** не включен `--use-replayssm`; `MambaMixer2` в этом случае держит `replayssm_buffer_len = None`. **Лечение:** добавить `--use-replayssm`.
- **Симптом:** после увеличения значения выросла нехватка VRAM или упало `GPU KV cache size: N tokens`. **Причина:** mamba-страница и скрэтч выросли линейно по B. **Лечение:** вернуть меньшее значение либо понизить `--max-num-seqs`.
- **Симптом:** выигрыша от ReplaySSM нет на коротких ответах. **Причина:** генерация короче B шагов, флаш не наступает, но и экономии на повторяющихся записях не набирается. **Лечение:** уменьшить B до порядка типичной длины ответа.
- **Симптом:** в гибридной модели вырос `--block-size`. **Проверка:** строка `Setting attention block size to N tokens to ensure that attention page size is >= mamba page size.` в логе старта.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --use-replayssm --replayssm-buffer-len 32 --mamba-backend triton
```

```bash
vllm serve /models/Nemotron-H-8B --use-replayssm --replayssm-buffer-len 16 --mamba-block-size 256 --enable-prefix-caching --mamba-cache-mode align
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_utils.py`
- `vllm/vllm/model_executor/layers/mamba/ops/selective_state_update_replayssm_output_only.py`
- `vllm/vllm/model_executor/models/nemotron_h.py`
- `vllm/vllm/v1/attention/backends/mamba_attn.py`
- `vllm/vllm/v1/worker/gpu_input_batch.py`
