---
schema: 1
engine: sglang
primaryName: "--linear-replayssm-cache-len"
title: "--linear-replayssm-cache-len"
summary: Длина кольцевого буфера ReplaySSM: полное рекуррентное состояние сбрасывается в HBM раз в L decode-шагов. Прямой множитель размера кольца и обратный множитель частоты сбросов.
group: exec.mamba
related:
  - --enable-linear-replayssm
  - --enable-linear-replayssm-spec
  - --enable-gdn-replayssm-spec
  - --speculative-num-draft-tokens
  - --mamba-ssm-dtype
  - --mamba-track-interval
  - --max-mamba-cache-size
  - --mem-fraction-static
---

# --linear-replayssm-cache-len

## Кратко

Оба режима ReplaySSM держат на каждый слот кольцо записей и сбрасывают полное состояние в HBM не каждый шаг, а раз в L шагов. `--linear-replayssm-cache-len` задает это L. Значение напрямую умножает размер кольца (память) и обратно пропорционально определяет частоту дорогих сбросов (пропускная способность). Значение по умолчанию 16.

Роль у аргумента разная в двух режимах. В decode-режиме (`--enable-linear-replayssm`) L — это буквально период сброса. В спекулятивном режиме (`--enable-linear-replayssm-spec`) L используется как длина окна только для KDA-моделей; у GDN окно берется по максимальному числу черновых токенов, и этот аргумент на них не влияет.

## Оригинальная справка

```text
Ring-buffer length L for ReplaySSM linear-attn decode. The full recurrent state is flushed to HBM every L decode steps.
```

## Паспорт аргумента

- Флаги: `--linear-replayssm-cache-len`
- Группа: `exec.mamba`
- Тип значения: int (число decode-шагов)
- Допустимые значения: argparse ограничений не накладывает. Дальнейшие проверки зависят от режима: не меньше 1 при `--enable-linear-replayssm`; для KDA в спекулятивном режиме — степень двойки и не меньше `2 × --speculative-num-draft-tokens`
- Значение по умолчанию: `16`
- Эффективное значение: совпадает с заданным. В спекулятивном режиме на GDN-моделях вместо него используется `--speculative-num-draft-tokens` (если он задан), и тогда аргумент не влияет ни на что
- Где объявлен: `ServerArgs.linear_replayssm_cache_len`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: `__post_init__` (валидация при включенном decode-кольце) → аллокация `MambaPool` → каждый decode-шаг / шаг верификации

## Что меняет в движке

### Размер кольца

Кольцевые тензоры `MambaPool` (`sglang/python/sglang/srt/mem_cache/memory_pool.py`) имеют форму `[layers, slots, heads, L, dim]`, то есть память линейна по L. Численно на Qwen3-Next-80B-A3B (36 линейных слоев, `HV=32`, `H=16`, `V=K=128`, tp=1) в decode-режиме:

| L | `--mamba-ssm-dtype float32` | `--mamba-ssm-dtype bfloat16` |
| --- | --- | --- |
| 8 | 6.79 MiB на слот | 3.41 MiB на слот |
| 16 | 13.57 MiB на слот | 6.82 MiB на слот |
| 32 | 27.14 MiB на слот | 13.64 MiB на слот |

Для сравнения, само состояние слота на той же модели — 73.7 MiB (fp32) или 37.7 MiB (bf16). В decode-режиме эта прибавка **не учтена** в бюджетном решении `_handle_max_mamba_cache`; в спекулятивном режиме учтена (`replayssm_ring_bytes_per_req`).

### Курсор и сброс

`HybridLinearAttnBackend` продвигает общий курсор `replayssm_write_pos` по модулю L и объявляет сброс, когда `write_pos == L - 1`. Для GDN добавляется принудительный сброс на границе трека radix-кеша (`seq_len % --mamba-track-interval == 0`), после которого курсор обнуляется. То есть реальная средняя длина цикла между сбросами равна `min(L, mamba_track_interval)` — задавать L больше интервала трека бессмысленно.

### Ограничения спекулятивного режима у KDA

В аллокаторе пула:

```text
spec-verify ring length must be a power of two, got 12
spec-verify ring too small: 8 < 2 * 6 (early-flush margin)
```

Первое — требование кольцевой арифметики, второе — запас на ранний сброс: окно должно вмещать два полных набора черновых токенов.

## Значения и формат

- Целое число шагов. Практически всегда степень двойки: для KDA в спекулятивном режиме это требование, в остальных — просто удобная арифметика.
- `1` формально допустимо при decode-кольце, но лишает флаг смысла: сброс на каждом шаге эквивалентен базовому пути плюс накладные расходы на кольцо.
- Значения больше `--mamba-track-interval` на GDN не дают дополнительного выигрыша: принудительный сброс наступит раньше естественного.
- Без обоих флагов ReplaySSM значение принимается и не используется.

## Когда использовать

- Уменьшать (8), когда кольцо не влезает в память: в decode-режиме оно не заложено в бюджет, и снижение L — самый прямой способ вернуть VRAM без потери слотов пула.
- Увеличивать (32), когда decode заведомо упирается в HBM, батч большой и память есть: реже сбросы — меньше трафика.
- Обязательно проверять при спекуляции на KDA: значение по умолчанию 16 не подходит, если `--speculative-num-draft-tokens` больше 8.
- Не подбирать на GDN в спекулятивном режиме: там окно определяется числом черновых токенов, а не этим аргументом.

## Влияние на производительность и память

- VRAM: линейно, `(N + 1) × L × (постоянная модели)`, где N — размер пула состояний. В decode-режиме это неучтенная прибавка сверх бюджета.
- RAM хоста: не влияет.
- Время старта: только за счет объема аллокаций.
- Throughput decode: чем больше L, тем реже полная запись состояния в HBM — в этом и есть выигрыш ReplaySSM. Эффект насыщается на `L = mamba_track_interval` для GDN.
- Latency: шаги-сбросы дороже остальных; при большом L дисперсия времени шага растет.
- Точность: в decode-режиме реконструкция выхода из кольца численно эквивалентна базовому пути. В спекулятивном режиме при типе состояния ниже fp32 каждое сворачивание переквантует состояние, и длинное кольцо означает более длинный переигрываемый префикс между переквантованиями.

## Взаимодействие с другими аргументами

- `--enable-linear-replayssm`: основной потребитель; требует L не меньше 1.
- `--enable-linear-replayssm-spec`: для KDA — длина окна (степень двойки, не меньше `2 × --speculative-num-draft-tokens`); для GDN не используется, если задано число черновых токенов.
- `--speculative-num-draft-tokens`: нижняя граница для KDA и замена значения для GDN.
- `--mamba-ssm-dtype`: тип записей decode-кольца совпадает с типом состояния, поэтому `bfloat16` уменьшает кольцо вдвое. В спекулятивном режиме сырые кольца хранятся в conv/активационном типе, а `g` и `beta` — всегда в fp32.
- `--mamba-track-interval`: верхняя граница полезного значения L для GDN.
- `--max-mamba-cache-size` / `--mem-fraction-static`: общий объем, из которого кольцо берет свою долю.

## Типовые проблемы и диагностика

- `ValueError: --linear-replayssm-cache-len must be >= 1, got 0`
- `ValueError: spec-verify ring length must be a power of two, got 12` — только KDA в спекулятивном режиме.
- `ValueError: spec-verify ring too small: 8 < 2 * 6 (early-flush margin)` — поднимите значение до ближайшей степени двойки, не меньшей `2 × --speculative-num-draft-tokens`.
- Увеличили L, а throughput не вырос — сработал принудительный сброс по `--mamba-track-interval`; поднимайте интервал вместе с L или не поднимайте L.
- CUDA OOM после включения decode-кольца — прибавка кольца не заложена в бюджет; уменьшайте L либо `--mem-fraction-static`.
- Что смотреть в логе: `GDN ReplaySSM ring buffers allocated (record_len=…, fold=…): d=…GB, k=…GB, g=…GB` — `record_len` показывает, какое значение реально применилось (L или число черновых токенов), а объемы — цену выбора.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-linear-replayssm --linear-replayssm-cache-len 32 --mamba-track-interval 256
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --enable-linear-replayssm-spec --linear-replayssm-cache-len 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_linear_attn_backend.py`
- `sglang/python/sglang/srt/configs/mamba_utils.py`
