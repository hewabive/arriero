---
schema: 1
engine: sglang
primaryName: "--kv-cache-dtype"
title: "--kv-cache-dtype"
summary: Тип хранения KV-кеша. fp8 вдвое уменьшает байты на токен и во столько же раз увеличивает вместимость пула, но поддержан не всеми attention backend'ами — часть комбинаций падает на старте, часть молча меняет backend.
group: model
related:
  - --attention-backend
  - --decode-attention-backend
  - --prefill-attention-backend
  - --dsa-prefill-backend
  - --dsa-decode-backend
  - --quantization-param-path
  - --dtype
  - --mem-fraction-static
  - --page-size
  - --prefill-only-disable-kv-cache
---

# --kv-cache-dtype

## Кратко

`--kv-cache-dtype` меняет только формат хранения KV-кеша — веса и активации остаются в `--dtype`. Экономия прямая: `cell_size` (байт на токен) считается как `элементы × element_size(kv_cache_dtype)`, поэтому fp8 вместо bf16 ровно вдвое увеличивает `max_total_num_tokens` при том же `--mem-fraction-static`. Цена — совместимость: каждый attention backend поддерживает свой набор типов, и часть сочетаний движок отвергает на старте, а одно (`fa3` + `fp8_e5m2`) молча переключает backend на `triton`.

## Оригинальная справка

```text
Data type for kv cache storage. "auto" will use model data type. "bf16" or "bfloat16" for BF16 KV cache. "fp8_e5m2" and "fp8_e4m3" are supported for CUDA 11.8+. "mxfp8" is supported by the FA4 backend. "nvfp4" selects the NVFP4 FP4 E2M1 KV cache recipe; "fp4_mx_block16" selects the MX-style block-size-16 FP4 E2M1 KV cache recipe. Both require CUDA 12.8+ and PyTorch 2.8.0+
```

## Паспорт аргумента

- Флаги: `--kv-cache-dtype`
- Группа: `model`
- Тип значения: строка
- Допустимые значения (из `choices`): `auto`, `fp8_e5m2`, `fp8_e4m3`, `mxfp8`, `bf16`, `bfloat16`, `nvfp4`, `fp4_mx_block16`, `fp4_e2m1`. Последнее argparse примет, но `configure_kv_cache_dtype` бросит `--kv-cache-dtype=fp4_e2m1 is deprecated. Use --kv-cache-dtype=fp4_mx_block16.`
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в тип модели либо в `fp8_e4m3`, если у квантизации модели объявлен `kv_cache_quant_algo == "FP8"`; для DeepSeek-DSA (V3.2) `auto` принудительно становится `fp8_e4m3` на SM100+ и `bfloat16` на более старых картах; поле объявлено `resolvable=True`, то есть архитектурные декларации могут его переписать
- Где объявлен: `ServerArgs.kv_cache_dtype`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → проверки совместимости в `__post_init__` (`_handle_kv4_compatibility`, `_handle_mxfp8_kv_cache_compatibility`, декларации MLA-backend'ов) → `ModelRunner.configure_kv_cache_dtype` после загрузки весов → расчет `cell_size` и выделение KV-пула → attention backend

## Что меняет в движке

Строка превращается в `torch.dtype` в `configure_kv_cache_dtype` (`sglang/python/sglang/srt/mem_cache/kv_cache_dtype.py`):

| значение | torch-тип | примечание |
| --- | --- | --- |
| `auto` | `model_dtype`, либо `float8_e4m3fn` | fp8 выбирается, только если `quant_config.kv_cache_quant_algo == "FP8"` |
| `fp8_e5m2` | `float8_e5m2` (на ROCm — нативный `fp8_dtype`) | |
| `fp8_e4m3` | `float8_e4m3fn` (на ROCm — нативный `fp8_dtype`) | |
| `mxfp8` | `float8_e4m3fn` + отдельные буферы масштабов | блок 32 |
| `bf16` / `bfloat16` | `bfloat16` | |
| `nvfp4`, `fp4_mx_block16` | `float4_e2m1fn_x2` | требует PyTorch с этим типом, иначе `ValueError` |
| `fp4_e2m1` | — | `ValueError`, устаревшее имя |

Дальше тип идет в `MemoryPoolConfigurator._compute_cell_size`: `kv_size = element_size(kv_cache_dtype)`, и для не-MLA моделей `cell_size = num_kv_heads * (head_dim + v_head_dim) * num_layers * kv_size`. Для `mxfp8` к этому добавляется `1/32` на масштабы, для FP4 — размер делится пополам и добавляются scale-буферы плюс общий fp8-workspace деквантования. Именно `cell_size` делит доступную VRAM: `max_total_num_tokens = available_bytes // cell_size`.

Отдельная деталь для DFLASH: если fa4-драфт не может читать fp8-KV таргета, ему выдается собственный KV в compute-типе (лог «DFLASH fa4 draft: overriding KV cache dtype … cannot read the target's quantized KV»).

## Что поддерживают backend'ы

Проверено по коду checkout'а — это то, что реально валидируется, а не общий обзор:

- **`fa3`**: fp8 только `fp8_e4m3`. Комбинация `fa3` + `fp8_e5m2` не падает, а **меняет backend**: «FlashAttention3 only supports fp8_e4m3 if using FP8; Setting attention backend to triton.» (`_attention_backend_fa3_fp8_fallback`). Молчаливая потеря производительности, если не прочитать лог.
- **`fa4`**: единственный backend, о котором справка говорит про `mxfp8`. Дополнительно `mxfp8` требует SM100+ — иначе `ValueError: --kv-cache-dtype mxfp8 requires an SM100+ (Blackwell) GPU …`.
- **`trtllm_mla`**: только `fp8_e4m3`, `fp4_e2m1`, `bf16`, `auto` — иначе `ValueError: TensorRT-LLM MLA backend only supports kv-cache-dtype of fp8_e4m3, fp4_e2m1, bf16, or auto.` Сам backend требует Blackwell.
- **`tokenspeed_mla`**: строго `fp8_e4m3`, иначе `ValueError: tokenspeed_mla backend requires kv-cache-dtype=fp8_e4m3, got …`.
- **`hpc_ops`**: только `bfloat16` или `fp8_e4m3`, иначе `ValueError: The hpc_ops attention backend only supports bf16 or fp8_e4m3 KV cache, got …`; fp8-путь дополнительно требует поддерживаемой конфигурации голов.
- **`flashinfer`**: fp8 (`e4m3`/`e5m2`) принимается — на fp8 тензорные ядра используются независимо от размера GQA-группы.
- **FP4 (`nvfp4`, `fp4_mx_block16`)**: `nvfp4` требует SM100/SM120 (`RuntimeError: --kv-cache-dtype=nvfp4 requires Blackwell SM100 or SM120. Use --kv-cache-dtype=fp4_mx_block16 …`). При `prefill == fa4` набор decode-backend'ов ограничен ассертом: для MLA — `cutlass_mla`/`flashinfer`/`trtllm_mla`, для MHA — `triton`/`torch_native`/`flex_attention`. Если prefill и decode различаются и prefill не `fa4`, движок ограничивается предупреждением «Compatibility issues are unlikely, but may occur in rare edge cases».
- **DeepSeek-DSA (V3.2)**: при `auto` подставляется fp8/bf16 по capability, а при явно заданных `--dsa-prefill-backend`/`--dsa-decode-backend` и `auto` печатается предупреждение с требованием задать KV-dtype явно.
- **MiniMax-M3**: fp8-путь attention-GEMM включается сам, но только при `fp8_e4m3` + `trtllm_mha` + SM100; `fp8_e5m2` там прямо назван причиной неправильного диспатча.
- **`--prefill-only-disable-kv-cache`**: несовместим с `nvfp4`, `fp4_mx_block16` и `mxfp8` — `ValueError` на старте.

Общий вывод: **безопасный fp8-выбор — `fp8_e4m3`**. `fp8_e5m2` поддержан заметно уже и в двух местах явно назван проблемным.

## Значения и формат

- `bf16` и `bfloat16` — синонимы; для DSA-ветки `bf16` нормализуется в `bfloat16`.
- `auto` не означает «bf16»: он означает «тип модели», а для FP8-квантованных чекпоинтов с `kv_cache_quant_algo=FP8` — fp8.
- `fp4_e2m1` оставлено в `choices` только ради понятной ошибки; используйте `fp4_mx_block16`.
- fp8 без калибровочных масштабов работает с масштабом 1.0 — апстрим прямо предупреждает про точность и предлагает `--quantization-param-path` с JSON-файлом коэффициентов.

## Когда использовать

- `fp8_e4m3` — когда упираетесь в вместимость KV-пула (частые вытеснения префиксов, маленький `max_total_num_tokens`) и backend его поддерживает. Это дает примерно вдвое больше токенов на ту же VRAM.
- `bfloat16` явно — когда модель fp8-квантована, но вы хотите точный KV и готовы платить памятью: `auto` в этом случае сам выберет fp8.
- FP4-рецепты (`nvfp4`, `fp4_mx_block16`) — только на Blackwell и только с проверенной парой backend'ов; сам код при их включении печатает «… KV Cache might lead to an accuracy drop!».
- Не трогайте на DeepSeek V3.2, если не задаете DSA-backend'ы вручную: автоподбор по capability там точнее ручного.

## Влияние на производительность и память

- Байты на токен меняются пропорционально размеру элемента: bf16 → 2, fp8 → 1, FP4 → 0.5 плюс масштабы. Соответственно меняется `max_total_num_tokens`.
- `mxfp8` добавляет `1/32` объема на scale-факторы; FP4 добавляет scale-буферы блоками 16 и общий fp8-workspace.
- Больше токенов в пуле — выше hit rate radix cache и реже вытеснения, то есть выигрыш в latency сверх экономии памяти.
- Обратная сторона: часть kernel'ов на fp8 быстрее (меньше трафика памяти), часть требует конвертации `q` в тип KV на каждом forward — в FA-backend'е это явное `q.to(self.kv_cache_dtype)`.
- Качество: fp8 KV — приближение. Для `fp8_e4m3` без масштабов ошибка заметнее на длинном контексте; это тот случай, когда стоит проверить свою метрику, а не верить дефолту.

## Взаимодействие с другими аргументами

- `--attention-backend` / `--prefill-attention-backend` / `--decode-attention-backend`: главный источник несовместимостей, список выше.
- `--dtype`: определяет, во что развернется `auto`.
- `--quantization-param-path`: JSON с масштабами KV; апстрим настаивает на нем для fp8.
- `--mem-fraction-static`, `--page-size`: KV-dtype меняет `cell_size`, но не логику деления памяти; пул по-прежнему выравнивается по странице.
- `--dsa-prefill-backend`, `--dsa-decode-backend`: при их указании KV-dtype нужно задавать явно.
- `--prefill-only-disable-kv-cache`: запрещает fp4/mxfp8.

## Типовые проблемы и диагностика

- `ValueError: --kv-cache-dtype mxfp8 requires an SM100+ (Blackwell) GPU …` / `RuntimeError: --kv-cache-dtype=nvfp4 requires Blackwell SM100 or SM120.` — железо не то.
- `ValueError: TensorRT-LLM MLA backend only supports kv-cache-dtype of fp8_e4m3, fp4_e2m1, bf16, or auto.` — сузьте KV-dtype или смените backend.
- `ValueError: --kv-cache-dtype=fp4_e2m1 is deprecated. Use --kv-cache-dtype=fp4_mx_block16.` — переименование.
- `ValueError: --kv-cache-dtype=nvfp4 requires torch.float4_e2m1fn_x2 support. Please use PyTorch 2.8.0+ with CUDA 12.8+.` — версия PyTorch.
- Тихая деградация throughput после включения `fp8_e5m2` на `fa3` — ищите в логе «Setting attention backend to triton»; backend сменился.
- Ожидали роста вместимости, а `max_total_num_tokens` не изменился — значение не применилось (перекрыто декларацией архитектуры или DSA-веткой). Смотрите дамп `server_args=` и строку планировщика `max_total_num_tokens=…, …, context_len=…`.
- `AssertionError: KV4 FA4 MLA expects decode_attention_backend to be one of […]` — FP4 с несовместимой парой backend'ов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kv-cache-dtype fp8_e4m3 --attention-backend fa3 --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --kv-cache-dtype bfloat16 --dsa-prefill-backend flashmla_sparse --dsa-decode-backend flashmla_kv --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_dtype.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/layers/attention/hpc_ops_backend.py`
- `sglang/python/sglang/srt/layers/attention/flashattention_backend.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_backend.py`
- `sglang/docs/docs/advanced_features/attention_backend.mdx`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
