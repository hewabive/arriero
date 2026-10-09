---
schema: 1
engine: sglang
primaryName: "--prefill-kv-cache-dequant-dtype"
title: "--prefill-kv-cache-dequant-dtype"
summary: При `--kv-cache-dtype nvfp4` выбирает, как prefill-attention читает FP4-кеш — напрямую (`nvfp4`, TRT-LLM GenMHA, только SM100) или через временный FP8-workspace (`fp8_e4m3`, FlashInfer) — и по нему назначает prefill-backend. Хранимый dtype KV не меняется; при любом другом `--kv-cache-dtype` допустим только `auto`.
group: exec.kernel
related:
  - --kv-cache-dtype
  - --prefill-attention-backend
  - --decode-attention-backend
  - --attention-backend
  - --speculative-attention-mode
  - --speculative-draft-attention-backend
  - --page-size
---

# --prefill-kv-cache-dequant-dtype

## Кратко

NVFP4-кеш (`--kv-cache-dtype nvfp4`) хранит K/V в упакованном FP4 с блочными scale'ами. Decode всегда читает его нативно через `trtllm_mha`, а для prefill есть два пути: читать упакованный FP4 напрямую ядром TRT-LLM GenMHA (`nvfp4`, только SM100) или на лету деквантовать нужные страницы во временный FP8 E4M3 workspace и считать attention FlashInfer'ом (`fp8_e4m3`). Аргумент выбирает путь и тем самым prefill-backend; задавать backend'ы руками при `nvfp4` не нужно. Аргумент новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Online dequantization dtype used by prefill attention when --kv-cache-dtype=nvfp4. 'nvfp4' reads the packed cache directly without additional dequantization; 'fp8_e4m3' dequantizes it into a temporary FP8 workspace. This does not change the stored KV-cache dtype. 'auto' selects NVFP4 without additional dequantization on SM100 and FP8 E4M3 otherwise.
```

## Паспорт аргумента

- Флаги: `--prefill-kv-cache-dequant-dtype`
- Группа: `exec.kernel`
- Тип значения: str
- Допустимые значения: `auto`, `nvfp4`, `fp8_e4m3`
- Значение по умолчанию: `auto`
- Эффективное значение: `handle_nvfp4_prefill_kv_dequant_dtype` (`arg_groups/kv_cache_hook.py`) при `--kv-cache-dtype nvfp4` разрешает `auto` в конкретный dtype и одновременно назначает `prefill_attention_backend` (`trtllm_mha` для `nvfp4`, `flashinfer` для `fp8_e4m3`) и `decode_attention_backend = trtllm_mha`. При другом `--kv-cache-dtype` значение остается `auto`, а любое другое — ошибка
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecKernel.prefill_kv_cache_dequant_dtype`
- Статус: обычный, поле `resolvable=True`
- Этап применения: `__post_init__` (выбор dtype и backend'ов, до общей проверки совместимости attention-backend'ов) → расчет `cell_size` и выделение KV-пула (наличие workspace и вторая раскладка scale'ов) → prefill-forward

## Что меняет в движке

Разрешение `auto` в `handle_nvfp4_prefill_kv_dequant_dtype`:

1. если явно задан `--prefill-attention-backend`, а без него `--attention-backend`, и это `trtllm_mha` или `flashinfer`, dtype выводится из backend'а (`trtllm_mha` → `nvfp4`, `flashinfer` → `fp8_e4m3`);
2. любой другой явно заданный backend — `ValueError: NVFP4 prefill supports an FP8 E4M3 workspace or native NVFP4, but backend '…' provides neither.`;
3. без явного backend'а — `nvfp4` на SM100, `fp8_e4m3` иначе (на практике SM120: сам `nvfp4`-кеш на других GPU отвергается `handle_kv4_compatibility`).

Затем `nvfp4` вне SM100 дает `ValueError: Native NVFP4 prefill currently requires SM100; use --prefill-kv-cache-dequant-dtype=fp8_e4m3 on this platform.`, явный `--prefill-attention-backend`, не совпадающий с нужным, — `ValueError … requires prefill backend …`, а `--decode-attention-backend` не `trtllm_mha` — `ValueError: NVFP4 decode requires --decode-attention-backend=trtllm_mha`. В лог идет `NVFP4 prefill dequant dtype: <dtype>; prefill input: <dtype>; decode input: nvfp4.`

Что меняется в пуле (`NVFP4KVCacheMethod`, `layers/quantization/fp4_kv_cache_quant_method.py`):

- **`nvfp4`** — prefill и decode читают одну и ту же физическую раскладку: упакованный FP4 и scale'ы в нативной HND-раскладке GenMHA. Workspace нет.
- **`fp8_e4m3`** — к FP4-данным добавляются token-linear scale'ы (их читает деквантование для FlashInfer) и общий для всех слоев FP8-workspace `dq_k`/`dq_v` размером `число токенов пула × KV-головы × head_dim` на K и столько же на V. На SM100 при этом сохраняются и нативные scale'ы для decode через GenMHA — смешанный рецепт держит обе раскладки. На SM120 decode через XQA использует linear-раскладку.

На SM100 decode через GenMHA всегда читает нативную раскладку, поэтому при любом значении аргумента требуются `--page-size`, кратный 4, и `head_dim`, кратный 64 (иначе `ValueError` при создании буферов). На SM120 нативной раскладки нет, и этих ограничений тоже.

Все эти буферы входят в `cell_size` пула (`compute_cell_size`), поэтому при том же `--mem-fraction-static` путь `fp8_e4m3` дает меньше токенов в KV-пуле.

## Значения и формат

- `auto` — по умолчанию; единственное допустимое значение при `--kv-cache-dtype`, отличном от `nvfp4` (иначе `ValueError: --prefill-kv-cache-dequant-dtype applies only with --kv-cache-dtype=nvfp4.`).
- `nvfp4` — нативный prefill без деквантования; только SM100.
- `fp8_e4m3` — prefill через FP8-workspace и FlashInfer; работает на SM100 и SM120.
- Хранимый dtype KV в обоих случаях — упакованный FP4: аргумент не влияет на то, что лежит в пуле, только на то, как prefill его читает и какие вспомогательные буферы рядом выделяются.

## Когда использовать

- SM100 и модель/конфигурация укладываются в нативный путь — оставляйте `auto` (то есть `nvfp4`): нет FP8-workspace и второй раскладки scale'ов, в пуле больше токенов.
- `fp8_e4m3` на SM100 — для сравнения точности или скорости prefill с FlashInfer. Ограничения на `page_size` и `head_dim` он не снимает: их задает decode через GenMHA.
- На SM120 выбора по сути нет: `auto` дает `fp8_e4m3`, а явный `nvfp4` — ошибку.
- Без `--kv-cache-dtype nvfp4` аргумент не трогайте.

## Влияние на производительность и память

- VRAM: `fp8_e4m3` добавляет workspace (одна FP8-копия K и V на весь объем пула, не умноженная на число слоев) и вторую раскладку scale'ов; все это вычитается из бюджета KV-пула, так что `max_total_num_tokens` в логе меньше, чем при `nvfp4`.
- Prefill: `fp8_e4m3` платит за деквантование страниц каждого слоя перед attention; `nvfp4` читает FP4 напрямую. Decode в обоих случаях один и тот же (`trtllm_mha` по нативным данным).
- Внутри GenMHA query и output считаются в FP8, результат конвертируется обратно в dtype активаций — это часть нативного пути, а не следствие аргумента.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype`: аргумент действует только при `nvfp4`.
- `--prefill-attention-backend` / `--attention-backend`: при `auto` явный `trtllm_mha` или `flashinfer` определяет dtype; при явном dtype backend должен совпадать с требуемым или не задаваться вовсе.
- `--decode-attention-backend`: допустим только `trtllm_mha` или ничего.
- `--speculative-attention-mode`: в смешанном SM100-рецепте (`fp8_e4m3` + `trtllm_mha` decode) со спекулятивным декодированием значение `prefill` переписывается в `decode` с предупреждением — target verify идет через GenMHA, а не через FP8-workspace.
- `--speculative-draft-attention-backend`: на SM100 draft-воркеру EAGLE/EAGLE3/NEXTN назначается `trtllm_mha`; другое явное значение — `ValueError`.
- `--page-size`: на SM100 должен быть кратен 4 при любом значении аргумента.
- На SM100 decode через `trtllm_mha` присутствует при любом значении аргумента, поэтому ограничения нативного NVFP4 (без PD-disaggregation, HiCache и LMCache; из спекулятивных алгоритмов — только EAGLE/EAGLE3/NEXTN и NGRAM с `--speculative-ngram-max-bfs-breadth 1`) действуют и для `fp8_e4m3`.

## Типовые проблемы и диагностика

- `ValueError: --prefill-kv-cache-dequant-dtype applies only with --kv-cache-dtype=nvfp4.` — аргумент задан без NVFP4-кеша.
- `ValueError: Native NVFP4 prefill currently requires SM100; use --prefill-kv-cache-dequant-dtype=fp8_e4m3 on this platform.` — явный `nvfp4` на SM120.
- `ValueError: --prefill-kv-cache-dequant-dtype=… requires prefill backend '…', but --prefill-attention-backend='…' was set.` — уберите `--prefill-attention-backend`.
- `ValueError: Native NVFP4 requires page_size divisible by 4` / `… head_dim divisible by 64` — на SM100 смена аргумента не поможет: меняйте `--page-size`, а при неподходящем `head_dim` модели NVFP4-кеш на SM100 недоступен.
- Какой путь выбран — строка `NVFP4 prefill dequant dtype: …` и итоговые `prefill_attention_backend` / `decode_attention_backend` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3.5-35B-A3B-FP8 --kv-cache-dtype nvfp4 --prefill-kv-cache-dequant-dtype nvfp4 --page-size 16
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3.5-35B-A3B-FP8 --kv-cache-dtype nvfp4 --prefill-kv-cache-dequant-dtype fp8_e4m3 --page-size 16
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/pipeline.py`
- `sglang/python/sglang/srt/layers/quantization/fp4_kv_cache_quant_method.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_backend.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/docs/docs/advanced_features/quantized_kv_cache.mdx`
