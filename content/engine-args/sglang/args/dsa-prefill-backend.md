---
schema: 1
engine: sglang
primaryName: "--dsa-prefill-backend"
title: "--dsa-prefill-backend"
summary: Ядро разреженного внимания DeepSeek (DSA) на фазе prefill. Читается только внутри backend'а `dsa`, то есть на DeepSeek V3.2 / GLM DSA и родственных архитектурах; при незаданном значении подбирается по `--kv-cache-dtype` и поколению карты.
group: exec.kernel
related:
  - --dsa-decode-backend
  - --dsa-topk-backend
  - --dsa-paged-mqa-logits-backend
  - --attention-backend
  - --kv-cache-dtype
  - --page-size
  - --enable-hisparse
  - --enable-dsa-cache-layer-split
---

# --dsa-prefill-backend

## Кратко

DSA (DeepSeek Sparse Attention) — это отдельный attention backend со своим внутренним выбором ядер: индексер отбирает top-k позиций, а затем разреженное внимание считается одной из нескольких реализаций. `--dsa-prefill-backend` выбирает реализацию для prefill/extend. Это не альтернатива `--attention-backend`, а второй уровень внутри него: значение читается только конструктором `DeepseekSparseAttnBackend` и не влияет ни на одну другую модель.

## Оригинальная справка

```text
DSA (DeepSeek Sparse Attention) prefill backend. If not specified, auto-detects based on hardware and kv_cache_dtype.
```

## Паспорт аргумента

- Флаги: `--dsa-prefill-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `flashmla_sparse`, `flashmla_sparse_q8`, `flashmla_kv`, `flashmla_auto`, `flashinfer_sparse_mla`, `fa3`, `tilelang`, `aiter`, `trtllm`. Список общий для prefill и decode, поэтому argparse примет и то, что применимо только к одной из фаз
- Значение по умолчанию: `null` — автоподбор
- Эффективное значение: подбирается в `_dsa_split_backend_resolution` (`sglang/python/sglang/srt/arg_groups/overrides.py`) только для DSA-моделей из списка `_DEEPSEEK_FAMILY_ARCHS` и не на NPU/XPU. Порядок: GLM DSA на SM120 с fp8 → `flashinfer_sparse_mla`; `--enable-hisparse` → выбор HiSparse-ветки; ROCm при обоих незаданных полях → `tilelang`; `--kv-cache-dtype fp8_e4m3` → `trtllm` на Blackwell и `flashmla_kv` на Hopper; иначе → `flashmla_sparse`. Результат печатается warning'ом `Set DSA backends for <dtype> KV Cache: prefill=…, decode=…`
- Где объявлен: `ServerArgs.dsa_prefill_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (автоподбор и проверки KV-dtype) → конфигурация KV-пула (`kv_cache_configurator.py`) → конструктор `DeepseekSparseAttnBackend` → каждый extend-forward

## Что меняет в движке

- Значение попадает в `DeepseekSparseAttnBackend.dsa_prefill_impl` (`sglang/python/sglang/srt/layers/attention/dsa_backend.py`) и определяет, какое ядро считает разреженное внимание на prefill.
- `flashmla_auto` включает `enable_auto_select_prefill_impl` — backend выбирает реализацию сам, по форме батча.
- `flashmla_sparse_q8` — нативный FP8-путь SM90. Конструктор проверяет обе предпосылки и падает явно: без `--kv-cache-dtype fp8_e4m3` — `--dsa-prefill-backend flashmla_sparse_q8 is native FP8 and requires --kv-cache-dtype fp8_e4m3 …`; вне SM90 — `--dsa-prefill-backend flashmla_sparse_q8 is SM90-only …`. Это единственный вариант, который существует только как prefill (в decode он отвергается отдельной ошибкой).
- `tilelang` на CUDA работает только с bf16-KV: `_check_tilelang_dsa_fp8_kv` бросает `ValueError` при `fp8_e4m3`, рекомендуя либо `--kv-cache-dtype bfloat16`, либо fp8-совместимый backend (`flashmla_kv` на Hopper, `trtllm` на Blackwell). На ROCm fp8 у tilelang поддержан.
- `flashinfer_sparse_mla` проверяется отдельной функцией `_validate_flashinfer_sparse_mla_backend` по архитектуре модели, SM-версии и типу KV; при его выборе выделяется workspace FlashInfer.
- Выбор влияет на **раскладку KV-пула**: `kv_cache_configurator.py` читает `dsa_prefill_backend`/`dsa_decode_backend` и отдельно обрабатывает `trtllm`, `tilelang` и `aiter`.
- Задание любого из двух DSA split-полей при `--kv-cache-dtype auto` печатает предупреждение с требованием задать тип KV явно: «DeepSeek V3.2 defaults to FP8 KV cache which may not be compatible with all backends».

Спекулятивное декодирование строит свои DSA-backend'ы через `sglang/python/sglang/srt/speculative/draft_utils.py`, используя те же поля.

## Значения и формат

- `null` (не задан) — автоподбор, и это правильное значение по умолчанию: он учитывает и dtype KV, и capability карты.
- Список `choices` общий для prefill и decode. Значение, применимое только к decode, argparse пропустит, а упадет уже backend.
- `flashmla_sparse` — базовый bf16-путь; `flashmla_sparse_q8` — его FP8-вариант для SM90; `flashmla_kv` — FP8-путь через KV; `trtllm` — Blackwell; `fa3` — Hopper без FP8; `tilelang` — универсальный (на CUDA только bf16); `aiter` — ROCm.
- Задание значения без явного `--kv-cache-dtype` почти всегда ошибка конфигурации: DSA-ветка сама подставит fp8 на SM100+ и bf16 ниже, и ваш backend может оказаться несовместим с подставленным типом.

## Когда использовать

- Когда автоподбор выбрал не то ядро, что вам нужно, и вы это измерили: например, на Hopper с fp8-KV дефолт даст `flashmla_kv`, а вам нужен нативный FP8-prefill `flashmla_sparse_q8`.
- Когда воспроизводите конфигурацию из туториала DeepSeek V3.2.
- Не задавайте на модели без DSA: поле просто не будет прочитано, backend `dsa` для нее вообще не создастся.
- Не задавайте только одно из двух полей, если не понимаете, что получит второе: они подбираются независимо, и результат может оказаться несогласованной парой.

## Влияние на производительность и память

- **VRAM.** Через конфигуратор KV-пула: `trtllm`, `tilelang` и `aiter` меняют раскладку индексного и KV-буферов; `flashinfer_sparse_mla` и Blackwell-путь дополнительно выделяют workspace размера `SGLANG_FLASHINFER_WORKSPACE_SIZE`.
- **TTFT.** Основной эффект: разреженный prefill — самая тяжелая часть DSA на длинных промптах, и разница между ядрами измеряется десятками процентов.
- **Точность.** FP8-варианты (`flashmla_sparse_q8`, `flashmla_kv`, `trtllm`) считают в пониженной точности и требуют fp8-KV; bf16-путь точнее и дороже по памяти.
- **Время старта.** `tilelang` компилирует ядра JIT.

## Взаимодействие с другими аргументами

- `--dsa-decode-backend`: вторая половина пары, подбирается по тем же правилам и независимо.
- `--kv-cache-dtype`: главный вход автоподбора и источник жестких проверок.
- `--attention-backend`: должен быть `dsa` (задается автоматически для DSA-моделей, если ни один из трех attention-флагов не задан).
- `--page-size`: для DSA-моделей выставляется в 64 (на ROCm без preshuffle-пути — 1).
- `--dsa-topk-backend`, `--dsa-paged-mqa-logits-backend`: ядра индексера, отдельные от этого выбора.
- `--enable-hisparse`: своя ветка автоподбора, приоритетнее общей.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: The tilelang DSA prefill/decode kernels only support an fp8_e4m3 KV cache on ROCm/HIP …`. **Решение:** `--kv-cache-dtype bfloat16` либо другой backend.
- **Симптом:** `ValueError: --dsa-prefill-backend flashmla_sparse_q8 is SM90-only …`. **Причина:** конфиг с Hopper на другой карте.
- **Симптом:** предупреждение про необходимость задать `--kv-cache-dtype` явно. **Причина:** задан DSA split-backend при `--kv-cache-dtype auto`.
- **Симптом:** значение задано, но в логе другой backend. **Проверка:** warning `Set DSA backends for … KV Cache: prefill=…, decode=…` — он печатается и тогда, когда автоподбор дополнил только одну половину.
- **Проверка:** дамп `server_args=` при старте показывает оба DSA-поля после автоподбора.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --kv-cache-dtype fp8_e4m3 --dsa-prefill-backend flashmla_sparse_q8 --dsa-decode-backend flashmla_kv --page-size 64
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --kv-cache-dtype bfloat16 --dsa-prefill-backend flashmla_sparse --dsa-decode-backend fa3 --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/attention/dsa_backend.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/speculative/draft_utils.py`
- `sglang/python/sglang/srt/arg_groups/hisparse_hook.py`
