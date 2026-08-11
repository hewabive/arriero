---
schema: 1
engine: sglang
primaryName: "--decode-attention-backend"
title: "--decode-attention-backend"
summary: Отдельный backend внимания для фазы decode. Имеет приоритет над `--attention-backend`, определяет большинство привязок `--page-size` и ограничений `--kv-cache-dtype`, а при расхождении с prefill-стороной включает экспериментальный `HybridAttnBackend`.
group: exec.kernel
related:
  - --attention-backend
  - --prefill-attention-backend
  - --speculative-draft-attention-backend
  - --page-size
  - --kv-cache-dtype
  - --enable-deterministic-inference
  - --disable-chunked-prefix-cache
  - --triton-attention-num-kv-splits
---

# --decode-attention-backend

## Кратко

`--decode-attention-backend` задает ядра внимания только для декодирующих проходов. Именно decode-сторона тянет за собой большинство привязок размера страницы (`flashmla` → 64, `cutlass_mla` → 128, `trtllm_mla`/`tokenspeed_mla`/`cutedsl_mla` → 32 или 64) и проверок типа KV-кеша, потому что декод — это то, где backend читает пул постранично. Расхождение с prefill-стороной включает `HybridAttnBackend` и сопровождающее предупреждение об экспериментальности.

## Оригинальная справка

```text
Choose the kernels for decode attention layers (have priority over --attention-backend).
```

## Паспорт аргумента

- Флаги: `--decode-attention-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения: тот же `ATTENTION_BACKEND_CHOICES`, что и у `--attention-backend` (`triton`, `torch_native`, `flex_attention`, `dsa`, `nsa`, `dsv4`, `compressed`, `cutlass_mla`, `fa3`, `fa4`, `flashinfer`, `flashmla`, `trtllm_mla`, `cutedsl_mla`, `tokenspeed_mla`, `trtllm_mha`, `dual_chunk_flash_attn`, `hpc_ops`, `aiter`, `wave`, `intel_amx`, `ascend`, `intel_xpu`), расширяемый out-of-tree платформами через `add_attention_backend_choices`
- Значение по умолчанию: `null` — фаза decode наследует разрешенный `--attention-backend`
- Эффективное значение: `attention_backends_of` возвращает `decode_attention_backend or attention_backend`. Само поле дописывается движком при `--device npu` (`ascend`) и для DeepSeek V4 на NPU (`dsv4`)
- Где объявлен: `ServerArgs.decode_attention_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`
- Этап применения: разбор CLI → `__post_init__` (привязки `--page-size`, проверки KV-dtype и SM) → создание backend'а в model runner → захват decode-графа CUDA → каждый шаг декодирования

## Что меняет в движке

- `_attention_backend_default` записывает значение в общее поле `attention_backend` только тогда, когда prefill и decode заданы одинаково. Если задан только decode, prefill получит автоподбор `_get_default_attn_backend`, и конфигурация станет гибридной.
- При разных backend'ах создается `HybridAttnBackend` (`sglang/python/sglang/srt/layers/attention/hybrid_attn_backend.py`) с двумя вложенными backend'ами; он же решает, какая половина обслуживает спекулятивный verify — по `--speculative-attention-mode`.
- Привязки `--page-size`, которые проверяют именно decode-поле (`_mla_backend_page_constraints`): `flashmla` → 64, `cutlass_mla` → 128, `trtllm_mla` → 32/64 (иначе 64), `tokenspeed_mla` → 32/64, `cutedsl_mla` → 32/64, `trtllm_mha` → 16/32/64/128, `hpc_ops` → 64. Полная картина — в справке `--page-size`.
- Проверки KV-dtype `_mla_kv_cache_dtype_checks` тоже смотрят на decode-поле: `trtllm_mla` требует Blackwell и `fp8_e4m3`/`fp4_e2m1`/`bf16`/`auto`, `tokenspeed_mla` — Blackwell и строго `fp8_e4m3`.
- `trtllm_mha` в decode допускается на SM90/SM100/SM120 — шире, чем в prefill (только SM100).
- `cutedsl_mla` в decode при незаданном prefill автоматически подставляет `trtllm_mla` в prefill; требует SM100 и KV-dtype из `fp8_e4m3`/`bf16`/`bfloat16`/`auto`.
- `_intel_xpu_page_constraint` читает разрешенный decode-backend: `intel_xpu` требует 64/128 (для MLA-декода 16/32/64/128), иначе принудительно 128.
- FP4 KV (`--kv-cache-dtype nvfp4`/`fp4_mx_block16`) при prefill=`fa4` ограничивает набор decode-backend'ов ассертом `KV4 FA4 MLA/MHA expects decode_attention_backend to be one of […]`.

## Значения и формат

- Значение вне списка отвергает argparse; несовместимое со средой — ассерт или `ValueError`, полный список общих отказов — в справке `--attention-backend`.
- `null` означает «взять разрешенный `--attention-backend`», а не какой-то отдельный дефолт.
- Мягкие подмены (`fa3` + `fp8_e5m2` → `triton`, платформенные fallback'и `intel_amx`/`intel_xpu`) написаны против общего поля `attention_backend`; значение, заданное в split-поле, они не трогают.

## Когда использовать

- Когда decode-фаза выигрывает от специализированного MLA-ядра (`trtllm_mla`, `cutedsl_mla`, `tokenspeed_mla`, `flashmla`), а prefill выгоднее оставить на ragged-пути FlashInfer или на `fa3`. Это оправдано только после раздельных замеров TTFT и TPOT.
- Когда backend физически декод-онли (`cutedsl_mla`).
- Не используйте как «упрощенный `--attention-backend`»: один split-флаг всегда даст гибридную конфигурацию.

## Влияние на производительность и память

- Decode-сторона определяет TPOT и профиль decode-графа CUDA: у `triton` персистентный fp32-буфер `attn_logits` размера `max_num_tokens × num_head × --triton-attention-num-kv-splits × v_head_dim × 4` байта, у FlashInfer/TRT-LLM — workspace, у `flashmla`/`cutlass_mla` — блочные таблицы под навязанный `--page-size`.
- Гибридная пара удваивает эти буферы: prefill-backend инициализируется полностью, даже если он используется реже.
- Навязанный decode-backend'ом `--page-size` меняет и вместимость KV-пула, и точность совпадения префиксов radix cache — эффект больше, чем от самих ядер.

## Взаимодействие с другими аргументами

- `--attention-backend`: перекрывается этим флагом для decode; при совпадении с prefill получает его значение.
- `--prefill-attention-backend`: вторая половина пары.
- `--page-size` и `--kv-cache-dtype`: основные источники несовместимостей, см. выше.
- `--triton-attention-num-kv-splits` и `--triton-attention-split-tile-size`: имеют смысл только когда decode обслуживает `triton` (или `wave`).
- `--enable-deterministic-inference`: сужает список допустимых backend'ов и может отключить radix cache.
- `--speculative-attention-mode`: решает, какая половина гибридной пары обслуживает verify.

## Типовые проблемы и диагностика

- **Симптом:** `page_size` в дампе отличается от заданного. **Причина:** привязка decode-backend'а. **Проверка:** warning `Cutlass MLA only supports a page_size of 128, change page_size to 128.` и аналогичные.
- **Симптом:** `ValueError: tokenspeed_mla backend requires kv-cache-dtype=fp8_e4m3, got …`. **Решение:** задать KV-dtype явно.
- **Симптом:** `ValueError: TRTLLM MHA backend for decode is only supported on Hopper (SM90), Blackwell (SM100) and (SM120) GPUs.`
- **Симптом:** неожиданный hybrid-warning при одном заданном split-флаге. **Причина:** вторая половина взята из автоподбора.
- **Проверка:** дамп `server_args=` при старте плюс строка `Using hybrid attention backend for decode and prefill: …`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --decode-attention-backend trtllm_mla --prefill-attention-backend flashinfer --page-size 64 --kv-cache-dtype fp8_e4m3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --decode-attention-backend triton --prefill-attention-backend fa3 --triton-attention-num-kv-splits 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_attn_backend.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/docs/docs/advanced_features/attention_backend.mdx`
