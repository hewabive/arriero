---
schema: 1
engine: vllm
primaryName: "--kv-cache-dtype"
title: "--kv-cache-dtype"
summary: Формат хранения KV-cache. Квантованный формат уменьшает байты на токен и увеличивает число блоков при том же бюджете памяти, но сужает список пригодных attention-backend'ов и влияет на точность.
group: CacheConfig
related:
  - --kv-cache-dtype-skip-layers
  - --attention-backend
  - --gpu-memory-utilization
  - --max-model-len
  - --dtype
  - --quantization
  - --block-size
---

# --kv-cache-dtype

## Кратко

`--kv-cache-dtype` определяет, в каком формате лежат K и V в блоках KV-cache. Это единственный аргумент, который меняет число байт на токен на слой, то есть напрямую масштабирует, сколько токенов помещается в тот же самый бюджет памяти.

Плата — точность и совместимость: список backend'ов, умеющих читать конкретный формат, ограничен, и неподходящее значение приводит не к предупреждению, а к отказу подобрать attention-backend.

## Оригинальная справка

```text
Data type for kv cache storage. If "auto", will use model data type.
CUDA 11.8+ supports fp8 (=fp8_e4m3) and fp8_e5m2. ROCm (AMD GPU) supports
fp8 (=fp8_e4m3). Intel Gaudi (HPU) supports fp8 (using fp8_inc).
Some models (namely DeepSeekV3.2) default to fp8, set to bfloat16 to use
bfloat16 instead, this is an invalid option for models that do not default
to fp8.
"nvfp4_4over6" uses the NVFP4 layout and selects between max/6 and max/4
scales per 16 values by minimizing squared reconstruction error.
```

## Паспорт аргумента

- Флаги: `--kv-cache-dtype`
- Группа argparse: `CacheConfig`
- Тип значения: enum (строка из фиксированного списка)
- Допустимые значения: `auto`, `float16`, `bfloat16`, `fp8`, `fp8_e4m3`, `fp8_e5m2`, `fp8_inc`, `fp8_ds_mla`, `turboquant_k8v4`, `turboquant_4bit_nc`, `turboquant_k3v4_nc`, `turboquant_3bit_nc`, `int4_per_token_head`, `int8_per_token_head`, `fp8_per_token_head`, `nvfp4`, `nvfp4_4over6`. Список статический (`CacheDType` в `vllm/config/cache.py`), но принимает его не парсер, а backend: реально работоспособное подмножество зависит от устройства и выбранного attention-backend'а
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в `create_engine_config` функцией `resolve_kv_cache_dtype_string` по `quantization_config` из HF-конфига модели — если чекпойнт объявляет алгоритм квантизации KV-cache, берется он. Дополнительно `Attention.__init__` подставляет `fp8`, если в quant-config есть `kv_cache_scheme`, а пользователь оставил `auto`
- Где объявлен: `vllm/config/cache.py:CacheConfig.cache_dtype`
- Этап применения: разбор CLI → `create_engine_config` (разрешение `auto`) → выбор attention-backend → построение KV-cache spec и расчет размера страницы → forward

## Что меняет в движке

Значение попадает в `CacheConfig.cache_dtype` и оттуда — в три независимых места.

1. **Размер страницы.** `FullAttentionSpec.page_size_bytes` (и MLA/SW-аналоги) считает байты на токен по `kv_cache_torch_dtype` и `kv_quant_mode`. При том же `available_kv_cache_memory` меньший dtype дает больше блоков — это и есть основной эффект.
2. **Выбор backend'а.** Каждый backend объявляет `supported_kv_cache_dtypes`. FlashAttention принимает `auto`, `float16`, `bfloat16`, `fp8`, `fp8_e4m3`; Triton — те же плюс `fp8_e5m2` и три `*_per_token_head`; FlashInfer — плюс `nvfp4` и `nvfp4_4over6` (и только на compute capability 10.x с работающим trtllm-attention). Несовместимое значение отбрасывает backend с причиной `kv_cache_dtype not supported`.
3. **Kernel и точность.** `is_quantized_kv_cache` считает квантованными все `fp8*`, `nvfp4*` и `*_per_token_head`. Для `*_per_token_head` масштабы считаются динамически на каждом шаге (в лог пишется `Using ... data type to store kv cache. It reduces the GPU memory footprint and boosts the performance. Dynamic per-token-head scales will be computed at runtime.`); для остальных квантованных форматов в лог идет вариант с оговоркой `it may cause accuracy drop without a proper scaling factor`.

Отдельная ветка — `turboquant_*`: после сборки `CacheConfig` в `create_engine_config` движок сам дописывает в `kv_cache_dtype_skip_layers` граничные слои, которые TurboQuant квантовать не должен (`TurboQuantConfig.get_boundary_skip_layers`). То есть при turboquant список skip-слоев не пуст даже если вы его не задавали, и следом срабатывает выравнивание `--block-size` под смешанные страницы.

## Значения и формат

- `auto` — «как у модели»: dtype KV совпадает с dtype весов, если чекпойнт не объявил свой алгоритм квантизации KV.
- `float16` / `bfloat16` — явное неквантованное хранение. Для моделей, чей чекпойнт по умолчанию просит fp8 (например, DeepSeekV3.2), `bfloat16` — это способ отказаться от fp8; для моделей, у которых fp8-дефолта нет, такой отказ бессмысленен.
- `fp8` — синоним `fp8_e4m3`. `fp8_e5m2` — другой раскрой мантиссы/экспоненты, поддержан меньшим числом backend'ов. `fp8_inc` — вариант для Intel Gaudi.
- `*_per_token_head` (`int4`, `int8`, `fp8`) — квантование с динамическими масштабами на токен и голову; масштабы не нужно калибровать заранее, но backend должен уметь `supports_per_head_quant_scales`.
- `nvfp4`, `nvfp4_4over6` — NVFP4-раскладка; `nvfp4_4over6` выбирает между масштабами `max/6` и `max/4` на каждые 16 значений по минимуму квадратичной ошибки восстановления.
- `turboquant_*` — упакованная K|V-раскладка со своим `TQFullAttentionSpec`; список skip-слоев автоматически дополняется граничными.
- Значения `None`/пустой строки нет: аргумент не `optional`.

## Когда использовать

- Переходить на `fp8`/`fp8_e4m3` имеет смысл, когда упираетесь в число одновременных запросов или в `--max-model-len`, а не в вычисления: примерно вдвое больше токенов в том же бюджете.
- `bfloat16` задают явно ровно в одном случае — чтобы отменить fp8-дефолт чекпойнта.
- Не переключайте формат «на всякий случай» на MLA-моделях: `nvfp4*` там запрещен явной проверкой конфига, а прочие квантованные форматы поддержаны не всеми MLA-backend'ами.
- Не считайте квантование KV бесплатным по точности: без корректных масштабов деградация реальна, и движок предупреждает об этом в логе.

## Влияние на производительность и память

- **VRAM.** Линейно масштабирует байты на токен, а значит и `GPU KV cache size: N tokens` при неизменном `--gpu-memory-utilization`.
- **Throughput.** Больше блоков — выше `Maximum concurrency`, меньше вытеснений. Сам kernel при fp8 обычно не медленнее; `*_per_token_head` добавляет расчет масштабов на каждом шаге.
- **Точность.** Квантованный KV влияет на качество на длинном контексте сильнее, чем на коротком.
- **Совместимость.** Может сменить выбранный attention-backend, а это уже влияет и на скорость, и на набор поддержанных фич (sliding window, attention sinks, sparse).
- **Время старта.** Не меняется.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype-skip-layers`: выводит перечисленные слои из-под квантования. Смешанные dtype в одном block pool заставляют движок поднять `--block-size` и добить страницы skip-слоев паддингом.
- `--attention-backend`: если backend задан явно и не поддерживает формат, старт падает сразу; если не задан — формат участвует в отборе backend'ов.
- `--block-size`: при смешанных dtype пересчитывается автоматически (`_align_heterogeneous_kv_block_size`).
- `--gpu-memory-utilization` / `--kv-cache-memory-bytes`: задают бюджет в байтах, `--kv-cache-dtype` — цену токена в этих байтах.
- `--max-model-len`, `--max-num-seqs`: определяют спрос; квантование KV — способ удовлетворить тот же спрос меньшей памятью.
- `--dtype` и `--quantization`: dtype весов и квантование весов — независимые оси; `auto` связывает dtype KV с dtype весов, явное значение эту связь разрывает.

## Типовые проблемы и диагностика

- **Симптом:** `No valid attention backend found for <device> with ... Reasons: {FLASH_ATTN: [kv_cache_dtype not supported], ...}`. **Причина:** ни один backend не умеет выбранный формат на этом устройстве. **Лечение:** вернуться к `auto`/`fp8` либо сменить устройство.
- **Симптом:** `Selected backend ... is not valid for this configuration. Reason: ['kv_cache_dtype not supported']`. **Причина:** конфликт явного `--attention-backend` и явного формата. **Лечение:** снять одно из двух ограничений.
- **Симптом:** `nvfp4 KV cache is not supported with MLA (Multi-head Latent Attention) backends. Please use a different --kv-cache-dtype (e.g. 'fp8' or 'auto') for MLA models such as DeepSeek.` **Причина:** запрет на уровне валидатора `VllmConfig`. **Лечение:** `fp8` или `auto`.
- **Симптом:** ответы заметно хуже на длинном контексте после включения fp8. **Причина:** без калибровки все масштабы квантования равны `1.0` (апстрим-документация по quantized KV cache проговаривает это явно). **Проверка:** в логе старта строка `Using fp8 ... It reduces the GPU memory footprint ... Meanwhile, it may cause accuracy drop without a proper scaling factor`. **Лечение:** вернуться к `auto` либо взять чекпойнт с калиброванными KV-масштабами.
- **Симптом:** задан `--kv-cache-dtype auto`, а в логе видно fp8. **Причина:** чекпойнт объявил алгоритм квантизации KV (`quantization_config`) либо `kv_cache_scheme` — `auto` разрешился в него. **Проверка:** `resolve_kv_cache_dtype_string` в `vllm/utils/torch_utils.py` и `quantization_config` в конфиге модели.
- **Проверка списка значений на своей сборке:** `vllm serve --help` в нужном окружении — набор `choices` меняется между релизами.

## Примеры

```bash
vllm serve /models/Qwen3-4B --kv-cache-dtype fp8 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/DeepSeek-V3.2 --kv-cache-dtype bfloat16 --max-model-len 16384
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/torch_utils.py`
- `vllm/vllm/v1/attention/backend.py`
- `vllm/vllm/v1/attention/backends/flash_attn.py`
- `vllm/vllm/v1/attention/backends/flashinfer.py`
- `vllm/vllm/v1/attention/backends/triton_attn.py`
- `vllm/vllm/model_executor/layers/attention/attention.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/docs/features/quantization/quantized_kvcache.md`
