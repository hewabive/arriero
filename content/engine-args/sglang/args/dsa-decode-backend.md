---
schema: 1
engine: sglang
primaryName: "--dsa-decode-backend"
title: "--dsa-decode-backend"
summary: Ядро разреженного внимания DeepSeek (DSA) на фазе decode. Читается только внутри backend'а `dsa`; при незаданном значении подбирается по `--kv-cache-dtype` и поколению карты, а значение `flashmla_sparse_q8` здесь запрещено явной ошибкой.
group: exec.kernel
related:
  - --dsa-prefill-backend
  - --dsa-topk-backend
  - --dsa-paged-mqa-logits-backend
  - --attention-backend
  - --kv-cache-dtype
  - --page-size
  - --enable-hisparse
  - --max-running-requests
---

# --dsa-decode-backend

## Кратко

`--dsa-decode-backend` выбирает реализацию разреженного внимания DeepSeek на шаге декодирования. Это второй уровень внутри attention backend'а `dsa` — на моделях без DSA поле не читается вообще. Автоподбор устроен так же, как у prefill-стороны, но результат у них может различаться: типичная связка на Hopper с bf16-KV — prefill `flashmla_sparse`, decode `fa3`.

## Оригинальная справка

```text
DSA (DeepSeek Sparse Attention) decode backend. If not specified, auto-detects based on hardware and kv_cache_dtype.
```

## Паспорт аргумента

- Флаги: `--dsa-decode-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `flashmla_sparse`, `flashmla_sparse_q8`, `flashmla_kv`, `flashmla_auto`, `flashinfer_sparse_mla`, `fa3`, `tilelang`, `aiter`, `trtllm`. Список общий с prefill-стороной, поэтому `flashmla_sparse_q8` argparse примет, а backend отвергнет
- Значение по умолчанию: `null` — автоподбор
- Эффективное значение: `_dsa_split_backend_resolution` (`sglang/python/sglang/srt/arg_groups/overrides.py`), только для DSA-моделей из `_DEEPSEEK_FAMILY_ARCHS` и не на NPU/XPU. GLM DSA на SM120 с fp8 → `flashinfer_sparse_mla`; `--enable-hisparse` → своя ветка; ROCm при обоих незаданных полях → `tilelang`; `--kv-cache-dtype fp8_e4m3` → `trtllm` на Blackwell, `flashmla_kv` на Hopper; иначе → `trtllm` на Blackwell и `fa3` на более старых картах. Итог печатается warning'ом `Set DSA backends for <dtype> KV Cache: prefill=…, decode=…`
- Где объявлен: `ServerArgs.dsa_decode_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (автоподбор и проверки) → конфигурация KV-пула → конструктор `DeepseekSparseAttnBackend` (аллокация workspace) → каждый шаг декодирования

## Что меняет в движке

- Значение становится `DeepseekSparseAttnBackend.dsa_decode_impl` (`sglang/python/sglang/srt/layers/attention/dsa_backend.py`).
- `flashmla_sparse_q8` в decode отвергается прямо в конструкторе: `--dsa-decode-backend flashmla_sparse_q8 is not supported: flashmla_sparse_q8 is a prefill-only backend. For FP8, use --dsa-prefill-backend flashmla_sparse_q8 together with --dsa-decode-backend flashmla_kv.` Это не подбор, а отказ старта.
- **Аллокация workspace зависит от decode-стороны.** Если выбран `flashinfer_sparse_mla` (после валидации `_validate_flashinfer_sparse_mla_backend` по архитектуре, SM и типу KV) — выделяется `dsa_flashinfer_sparse_mla_workspace`. Иначе, если карта SM100+ **или** decode-backend `trtllm`, выделяется `dsa_trtllm_workspace` плюс персистентный буфер счетчиков multi-CTA размером под `--max-running-requests`. В остальных случаях workspace не выделяется вовсе.
- На ROCm при `aiter` и fp8-KV заранее готовятся метаданные декода aiter (`_ensure_aiter_dsa_decode_metadata_buffer`), и число голов дополняется до кратного 16.
- `tilelang` на CUDA несовместим с fp8-KV (`_check_tilelang_dsa_fp8_kv`, `ValueError` на старте); на ROCm совместим.
- Раскладка KV-пула учитывает decode-поле: `kv_cache_configurator.py` отдельно ветвится на `trtllm` и на пару `tilelang`/`aiter`.

## Значения и формат

- `null` — автоподбор; правильное значение по умолчанию.
- `flashmla_sparse_q8` — недопустимо (prefill-only), см. выше.
- `flashmla_kv` — FP8-путь декода; на Hopper это то, что подставит автоподбор при fp8-KV.
- `trtllm` — Blackwell; `fa3` — Hopper с bf16-KV; `flashinfer_sparse_mla` — GLM DSA на SM120 c fp8; `aiter` — ROCm; `tilelang` — универсальный, на CUDA только bf16.
- Задание значения при `--kv-cache-dtype auto` печатает предупреждение о необходимости задать тип KV явно.

## Когда использовать

- Когда автоподбор дал не то ядро, и это подтверждено замерами TPOT: decode DSA — это то, что определяет скорость генерации на длинном контексте.
- Когда воспроизводите связку из туториала DeepSeek V3.2 (там decode и prefill обычно задаются парой).
- Не задавайте одно поле без второго: они подбираются независимо, и вы получите пару, которую никто не проверял.
- Не задавайте на модели без DSA.

## Влияние на производительность и память

- **VRAM.** Прямо: наличие и вид workspace (`SGLANG_FLASHINFER_WORKSPACE_SIZE`) плюс буфер счетчиков на `--max-running-requests` зависят именно от decode-backend'а и capability карты. Плюс раскладка KV-пула через конфигуратор.
- **TPOT.** Основной эффект: каждый токен проходит через это ядро.
- **Точность.** FP8-пути (`flashmla_kv`, `trtllm`) требуют fp8-KV и считают в пониженной точности.
- **Время старта.** `tilelang` компилирует ядра JIT; выделение workspace добавляет фиксированный кусок VRAM.

## Взаимодействие с другими аргументами

- `--dsa-prefill-backend`: вторая половина пары; для FP8 на Hopper штатная связка — `flashmla_sparse_q8` в prefill и `flashmla_kv` в decode.
- `--kv-cache-dtype`: вход автоподбора и источник жестких проверок; при DSA-модели и `auto` движок сам подставит fp8 на SM100+ и bf16 ниже.
- `--attention-backend`: должен быть `dsa`.
- `--page-size`: для DSA-моделей выставляется в 64 (на ROCm без preshuffle-пути — 1).
- `--max-running-requests`: определяет размер персистентного буфера счетчиков multi-CTA на TRT-LLM/Blackwell-пути.
- `--dsa-topk-backend`, `--dsa-paged-mqa-logits-backend`: ядра индексера, независимые от этого выбора.
- `--enable-hisparse`: своя ветка автоподбора, приоритетнее общей.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --dsa-decode-backend flashmla_sparse_q8 is not supported: … prefill-only backend.` **Решение:** перенести значение в `--dsa-prefill-backend`, а в decode поставить `flashmla_kv`.
- **Симптом:** `ValueError: The tilelang DSA prefill/decode kernels only support an fp8_e4m3 KV cache on ROCm/HIP …`. **Решение:** bf16-KV либо fp8-совместимый backend.
- **Симптом:** после смены decode-backend'а изменился расход VRAM на старте. **Причина:** появился или исчез workspace.
- **Симптом:** значение задано, а в логе другой backend. **Проверка:** warning `Set DSA backends for … KV Cache: prefill=…, decode=…`.
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
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/arg_groups/hisparse_hook.py`
