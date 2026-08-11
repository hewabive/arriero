---
schema: 1
engine: vllm
primaryName: "--mm-encoder-attn-dtype"
title: "--mm-encoder-attn-dtype"
summary: Включает FP8-квантизацию внимания ViT-энкодера. Единственное допустимое значение — `fp8`; работает только на семействе Qwen3-VL, только через FlashInfer cuDNN (Blackwell+) или AITER (MI300/MI350), и окупается на QHD/4K, а не на мелких картинках.
group: MultiModalConfig
related:
  - --mm-encoder-attn-backend
  - --mm-encoder-fp8-scale-path
  - --mm-encoder-fp8-scale-save-path
  - --mm-encoder-fp8-scale-save-margin
  - --dtype
  - --compilation-config
---

# --mm-encoder-attn-dtype

## Кратко

Это точка входа в отдельную подсистему — FP8-внимание ViT-энкодера. Q/K/V квантизуются в FP8 непосредственно перед вызовом attention-ядра; веса и остальные операции энкодера остаются в исходном типе.

Аргумент не самостоятельная ручка, а первый из четырёх, образующих один рабочий процесс: `--mm-encoder-attn-dtype` включает FP8, `--mm-encoder-fp8-scale-save-path` и `--mm-encoder-fp8-scale-save-margin` относятся к калибровке, `--mm-encoder-fp8-scale-path` — к эксплуатации с готовыми масштабами. Без файла масштабов используется динамическое шкалирование: скользящее окно из 16 наблюдаемых amax.

Область применимости узкая, и апстрим-документация её проговаривает: только модели семейства Qwen3-VL (`qwen3_vl`, `qwen3_vl_moe`, `qwen3_5`, `qwen3_5_moe` и другие на Qwen3-ViT).

## Оригинальная справка

```text
Optional dtype override for ViT encoder attention. Set to `"fp8"` to
enable FP8 quantization via the FlashInfer cuDNN backend. When set to
`"fp8"` without a scale file, dynamic scaling is used automatically.
See docs/features/quantization/fp8_vit_attn.md for details.
```

## Паспорт аргумента

- Флаги: `--mm-encoder-attn-dtype`
- Группа argparse: `MultiModalConfig`
- Тип значения: enum (строка) с допустимым `None`
- Допустимые значения: `fp8`; `optional: true`, поэтому argparse дополнительно принимает `None`
- Значение по умолчанию: `None` — FP8-путь выключен, внимание ViT считается в типе модели
- Эффективное значение: не переопределяется; при неподдерживаемом backend'е или железе конфигурация не откатывается, а падает с `ValueError`
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_encoder_attn_dtype`
- Этап применения: построение слоёв внимания энкодера (`_init_fp8_attn`) → загрузка весов (`process_weights_after_loading`) → каждый forward ViT

## Что меняет в движке

**Инициализация.** `MultiModalEncoderAttention._init_fp8_attn` (`vllm/model_executor/layers/attention/mm_encoder_attention.py`) выходит сразу, если значение не `fp8`. Иначе проверяет backend:

- `ROCM_AITER_FA` — требует ROCm, GPU семейства MI300/MI350 (`gfx942`/`gfx950`) и сборки AITER с `flash_attn_varlen_fp8_pertensor_func`;
- `FLASHINFER` — требует поддержки cuDNN FP8 prefill attention: cuDNN ≥ 9.17.1 на Blackwell (SM 100) и новее. Сообщение прямо оговаривает, что на Hopper (H100/H200) и раньше пути нет;
- любой другой backend — `ValueError: mm_encoder_attn_dtype='fp8' requires either the ROCM_AITER_FA backend on ROCm or the FlashInfer cuDNN backend on CUDA, got <...>`.

Дальше регистрируются буферы масштабов (форма `(1,1,1,1)` — требование cuDNN) и создаётся `QuantFP8` с per-tensor группировкой.

**Динамика против статики.** `self._fp8_dynamic_scale = mm_cfg.mm_encoder_fp8_scale_path is None`. При динамике заводится кольцевой буфер amax на 16 значений (`_FP8_AMAX_HISTORY_LEN`), и при загрузке весов пишется `FP8 attention enabled with dynamic scaling (no scale file provided). Scales will adapt from observed Q/K/V amax values (history_len=16).`

**Паддинг.** `vllm/model_executor/models/vision.py:get_fp8_padded_hidden_size()` возвращает `num_heads × round_up(head_dim, 16)` только при `fp8`: cuDNN требует `head_dim`, кратный 16, поэтому неровные значения (например 72) дополняются.

**Валидация конфигурации.** `MultiModalConfig._validate_multimodal_config` запрещает задавать `--mm-encoder-fp8-scale-path` или `--mm-encoder-fp8-scale-save-path` без `fp8`.

**Кэш компиляции.** Значение входит в `MultiModalConfig.compute_hash()`.

## Значения и формат

- Не задан (`None`) — FP8-путь выключен. Дефолт.
- `fp8` — единственное принимаемое значение.
- Слово `fp8` здесь означает квантизацию **только Q/K/V внимания энкодера**. Это не `--dtype` (тип весов и активаций модели) и не `--kv-cache-dtype` (тип KV-cache языковой модели).
- Отменить FP8 после включения можно только убрав флаг: значения «выключено» в `choices` нет, но `None` доступен как отдельный вариант.

## Когда использовать

- Qwen3-VL с крупными изображениями (QHD и выше) или несколькими изображениями на запрос, где по профилю видно, что ViT-внимание — узкое место. Особенно когда языковая часть уже квантована (NVFP4) и энкодер стал доминировать.
- Только на подходящем железе: GB200/GB300 и новее для FlashInfer-пути, MI300/MI350 — для AITER.
- Не включайте на HD и мельче: апстрим-замеры показывают, что на 720×1280 FP8 **медленнее** BF16 (0.87×) из-за накладных расходов на квантизацию; перелом около FullHD при трёх изображениях на запрос.
- Не включайте на моделях вне списка Qwen3-VL: путь просто не реализован для их ViT.
- Не включайте вместе с полными CUDA graphs ViT при динамическом шкалировании — комбинация не поддерживается.

## Влияние на производительность и память

- **Latency энкодера.** Главная целевая величина. По апстрим-замерам на ядре cuDNN: GB200 — 1.12×, GB300 — 1.42×. End-to-end на Qwen3-VL-30B-A3B, 3 изображения на запрос: QHD 1.08×, 4K 1.18×, FullHD примерно паритет, HD 0.87×.
- **Динамический оверхед.** Скользящее окно amax требует дополнительной работы на каждом forward'е; статические масштабы его снимают — ради этого и существует калибровочный процесс.
- **VRAM.** Экономия невелика: квантизуются транзиентные Q/K/V, а не веса. Дополнительно появляются буферы масштабов и, при неровном `head_dim`, паддинг.
- **Точность.** По апстрим-замерам на ChartQA (Qwen3-VL-8B, 500 сэмплов) BF16, FP8 dynamic и FP8 static совпадают в пределах статистического шума.
- **Время старта.** Практически не меняется; смена значения инвалидирует кэш компиляции графа.

## Взаимодействие с другими аргументами

- `--mm-encoder-attn-backend`: обязателен. Без явного `FLASHINFER` (CUDA) или `ROCM_AITER_FA` (ROCm) автоподбор почти наверняка даст другой backend, и старт упадёт.
- `--mm-encoder-fp8-scale-path`: переводит режим из динамического в статический; требует этого флага.
- `--mm-encoder-fp8-scale-save-path`, `--mm-encoder-fp8-scale-save-margin`: калибровочная половина процесса; тоже требуют `fp8`.
- `--dtype`: задаёт тип весов и активаций модели; FP8 здесь относится только к Q/K/V внимания ViT.
- `--compilation-config`: `cudagraph_mm_encoder` и динамическое шкалирование несовместимы.

## Типовые проблемы и диагностика

- **Симптом:** `mm_encoder_attn_dtype='fp8' requires the FlashInfer cuDNN backend with cuDNN >= 9.17.1 on Blackwell (SM 100) or newer. cuDNN's FP8 SDPA path with bf16/fp16 output is not available on Hopper (H100/H200) or earlier.` **Причина:** железо или версия cuDNN не подходят. **Лечение:** обновить FlashInfer/cuDNN либо отказаться от FP8 на этой карте.
- **Симптом:** `mm_encoder_attn_dtype='fp8' requires either the ROCM_AITER_FA backend on ROCm or the FlashInfer cuDNN backend on CUDA, got AttentionBackendEnum.FLASH_ATTN.` **Причина:** не задан подходящий backend. **Лечение:** добавить `--mm-encoder-attn-backend FLASHINFER` (или `ROCM_AITER_FA`).
- **Симптом:** `AITER FP8 ViT attention requires an MI300-series or MI350-series GPU (gfx942 or gfx950).` **Причина:** ROCm-карта не из поддержанного ряда.
- **Симптом:** `'mm_encoder_fp8_scale_path' and 'mm_encoder_fp8_scale_save_path' require 'mm_encoder_attn_dtype' to be 'fp8'.` **Причина:** задан путь масштабов без включения FP8.
- **Симптом:** FP8 включён, а стало медленнее. **Причина:** изображения мельче точки перелома либо активно динамическое шкалирование. **Лечение:** откалибровать статические масштабы или вернуться на BF16 для этого профиля нагрузки.
- **Подтверждение принятого значения:** `Using backend AttentionBackendEnum.FLASHINFER for vit attention` плюс `FP8 attention enabled with dynamic scaling (no scale file provided). Scales will adapt from observed Q/K/V amax values (history_len=16).` (динамика) либо `Loaded FP8 attention scales from <path> (N layers)` (статика).

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8
```

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8 --mm-encoder-fp8-scale-path /models/scales/qwen3vl-vit.json
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/model_executor/layers/attention/mm_encoder_attention.py`
- `vllm/vllm/model_executor/models/vision.py`
- `vllm/docs/features/quantization/fp8_vit_attn.md`
