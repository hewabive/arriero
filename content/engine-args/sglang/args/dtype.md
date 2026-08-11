---
schema: 1
engine: sglang
primaryName: "--dtype"
title: "--dtype"
summary: Тип вычислений для весов и активаций. `auto` берет `dtype` из конфига модели (FP32-чекпоинт понижается до FP16, у Gemma — до BF16). К квантизации отношения не имеет — за нее отвечает `--quantization`.
group: model
related:
  - --kv-cache-dtype
  - --quantization
  - --model-path
  - --model-impl
  - --enable-fp32-lm-head
  - --enable-tf32-matmul
  - --json-model-override-args
---

# --dtype

## Кратко

`--dtype` определяет `ModelConfig.dtype` — тип, в котором создаются параметры модели и считаются активации. Это **не** метод квантизации: fp8/awq/gptq задаются через `--quantization` и живут в весах, а `--dtype` описывает «несжатую» арифметику вокруг них. Дефолт `auto` почти всегда правильный: он читает `dtype`/`torch_dtype` из `config.json` и повторяет его. Ручное значение нужно в трех ситуациях — FP32-чекпоинт, требования конкретного kernel'а и AWQ-веса, для которых апстрим рекомендует FP16.

## Оригинальная справка

```text
Data type for model weights and activations.

* "auto" will use FP16 precision for FP32 and FP16 models, and BF16 precision for BF16 models.
* "half" for FP16. Recommended for AWQ quantization.
* "float16" is the same as "half".
* "bfloat16" for a balance between precision and range.
* "float" is shorthand for FP32 precision.
* "float32" for FP32 precision.
```

## Паспорт аргумента

- Флаги: `--dtype`
- Группа: `model`
- Тип значения: строка
- Допустимые значения: `auto`, `half`, `float16`, `bfloat16`, `float`, `float32` (проверяет argparse)
- Значение по умолчанию: `auto`
- Эффективное значение: разрешается в `_get_and_verify_dtype` по конфигу модели; кроме того поле объявлено `resolvable=True`, то есть его перекрывают per-architecture декларации — `MistralLarge3ForCausalLM` и `PixtralForConditionalGeneration` жестко переводятся в `bfloat16`, а GPT-OSS с `quant_method == "mxfp4"` тоже получает `bfloat16` («use bf16 for mxfp4 triton kernels»)
- Где объявлен: `ServerArgs.dtype`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → декларации архитектуры в `__post_init__` → `ModelConfig` (`_get_and_verify_dtype`) → создание модели и загрузка весов → сюда же завязан `auto` у `--kv-cache-dtype`

## Что меняет в движке

`ModelConfig.__init__` вызывает `_get_and_verify_dtype(hf_text_config, dtype)` (`sglang/python/sglang/srt/configs/model_config.py`). Логика такая:

1. `config_dtype` = `dtype`/`torch_dtype` из HF-конфига; строка отображается через таблицу `_STR_DTYPE_TO_TORCH_DTYPE`; отсутствие поля трактуется как `torch.float32`.
2. При `--dtype auto`:
   - `config_dtype == float32` и `model_type` начинается с `gemma` → `torch.bfloat16` (в лог уходит «For Gemma …, we downcast float32 to bfloat16 instead of float16 by default»);
   - `config_dtype == float32` в остальных случаях → `torch.float16`;
   - иначе — ровно то, что стоит в конфиге.
3. При явном значении оно просто мапится в `torch`-тип; неизвестное значение отсекает argparse раньше (`choices`).
4. Расхождение с конфигом не блокируется: апкаст в fp32, даункаст из fp32 и переход fp16↔bf16 логируются на уровне DEBUG и разрешаются.

Полученный `torch.dtype` дальше идет в `set_default_torch_dtype(model_config.dtype)` при создании модели, в расчет размеров пулов (`model_dtype`) и в `configure_kv_cache_dtype` — при `--kv-cache-dtype auto` KV-кеш получает **именно этот** тип, если у квантизации модели нет собственного `kv_cache_quant_algo`.

Есть и жесткие проверки платформы: GPT-OSS на Intel XPU принимает только `bfloat16` — при `auto` печатается предупреждение, при любом другом явном значении бросается `NotImplementedError`.

## Значения и формат

- `half` и `float16` эквивалентны; `float` и `float32` эквивалентны.
- `auto` — единственное значение, которое смотрит на модель. Все остальные применяются как есть, даже если модель обучалась в другом типе.
- `float16` на модели, обученной в bf16, — не ошибка, а тихий переход через DEBUG-лог. На больших активациях это реальный риск переполнения/NaN, и по симптомам он выглядит как деградация качества, а не как отказ.
- `float32` удваивает размер весов относительно bf16 — на практике применимо только к маленьким моделям и отладке численности.
- Значение не влияет на формат хранения квантованных весов: fp8/int4-веса остаются в своем формате, `--dtype` описывает тип, в котором они деквантуются и в котором идут активации.

## Когда использовать

- Оставьте `auto`, если у модели корректно заполнен `dtype` в `config.json`. Это подавляющее большинство случаев.
- Поставьте `bfloat16` явно, если чекпоинт лежит в fp32 (иначе `auto` даст fp16) и вам нужен диапазон bf16 — типичный случай для дообученных моделей, сохраненных с `torch_dtype: float32`.
- Поставьте `half`/`float16` для AWQ-весов — это прямая рекомендация из справки самого аргумента.
- Не пытайтесь через `--dtype` «включить fp8»: такого значения нет в `choices`, за квантизацию отвечает `--quantization`, за KV-кеш — `--kv-cache-dtype`.
- Не задавайте значение вручную для архитектур, у которых оно принудительно перекрыто (Mistral Large 3, Pixtral, GPT-OSS mxfp4) — ваше значение будет проигнорировано декларацией.

## Влияние на производительность и память

- VRAM под веса линейна по размеру типа: fp32 — 4 байта на параметр, fp16/bf16 — 2. Для квантованной модели `--dtype` меняет не веса, а буферы деквантования и активации.
- KV-пул: при `--kv-cache-dtype auto` тип KV равен `--dtype`, то есть `float32` учетверяет байты на токен относительно fp8 и удваивает относительно bf16 — и во столько же раз режет `max_total_num_tokens`.
- Скорость: fp32-путь на современных GPU считается тензорными ядрами хуже и почти всегда медленнее; TF32-ускорение матмулов включается отдельным `--enable-tf32-matmul`.
- Время старта: тип влияет на объем чтения/конвертации весов; переход между fp16 и bf16 делается при загрузке и заметен только на очень больших моделях.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype`: при значении `auto` наследует `--dtype`. Явный fp8/nvfp4 для KV полностью независим от `--dtype`.
- `--quantization`: описывает формат весов; `--dtype` — тип вычислений вокруг них. У GPT-OSS с mxfp4 квантизация принудительно ставит `--dtype bfloat16`.
- `--enable-fp32-lm-head`: точечно поднимает точность логитов независимо от `--dtype`.
- `--enable-tf32-matmul`: отдельная ручка ускорения fp32-матмулов.
- `--model-impl`: реализация модели (SGLang / Transformers / MindSpore) может иметь свои требования к типу; проверки платформы (Intel XPU) срабатывают уже после выбора.
- `--json-model-override-args`: позволяет переписать `dtype` прямо в HF-конфиге — тогда `auto` увидит уже переписанное значение.

## Типовые проблемы и диагностика

- `NotImplementedError: GptOssForCausalLM on Intel XPU only supports bfloat16 dtype, but got '…'` — платформенное ограничение, лечится `--dtype bfloat16` или снятием флага.
- Значение задано, а в логе видно другое — сработала архитектурная декларация (`MODEL_OVERRIDES`) или mxfp4-ветка. Проверяется по дампу `server_args=` при старте: декларации материализуются в поля до печати дампа, поэтому там уже итоговое значение.
- Резкая деградация качества без ошибок на bf16-модели — проверьте, не выставлен ли вручную `float16`.
- Неожиданно маленький `max_total_num_tokens` — при `--kv-cache-dtype auto` вы платите за KV тем же типом, что задали здесь.
- Фактический расход весов печатает строка `Load weight end. elapsed=… s, type=…, avail mem=… GB, mem usage=… GB.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --dtype bfloat16 --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3-8B-AWQ --dtype half --quantization awq
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_dtype.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
