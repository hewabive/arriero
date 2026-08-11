---
schema: 1
engine: vllm
primaryName: "--dtype"
title: "--dtype"
summary: Тип весов и активаций модели. Значение `auto` разрешается не по тексту справки, а по списку типов, поддержанных вашей картой, поэтому на Ampere и новее FP32-чекпоинт приезжает в BF16, а не в FP16.
group: ModelConfig
related:
  - --kv-cache-dtype
  - --quantization
  - --max-model-len
  - --gpu-memory-utilization
  - --hf-overrides
  - --override-attention-dtype
---

# --dtype

## Кратко

`--dtype` задаёт `torch.dtype`, в котором живут веса и активации. Это одна из двух ручек, напрямую задающих объём весов в VRAM (вторая — квантизация), и она же по умолчанию определяет тип KV-cache при `--kv-cache-dtype auto`.

Значение `auto` — не «как в чекпоинте». Это результат функции `_resolve_auto_dtype`, где решают три вещи: тип из конфига модели, список типов, поддержанных платформой, и чёрный список моделей, которым запрещён FP16.

## Оригинальная справка

```text
Data type for model weights and activations:

- "auto" will use FP16 precision for FP32 and FP16 models, and BF16
  precision for BF16 models.
- "half" for FP16. Recommended for AWQ quantization.
- "float16" is the same as "half".
- "bfloat16" for a balance between precision and range.
- "float" is shorthand for FP32 precision.
- "float32" for FP32 precision.
```

## Паспорт аргумента

- Флаги: `--dtype`
- Группа argparse: `ModelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `auto`, `half`, `float16`, `bfloat16`, `float`, `float32` (`ModelDType`); поле объявлено как `ModelDType | torch.dtype`, но `torch.dtype` доступен только из Python-API — на CLI работает список выше как настоящий `choices`
- Значение по умолчанию: `auto`
- Эффективное значение: разрешается в `_get_and_verify_dtype()` внутри `ModelConfig.__post_init__` — по `config_dtype` модели, по `current_platform.supported_dtypes` и по признаку pooling-модели; после этого `self.dtype` уже `torch.dtype`, а не строка
- Где объявлен: `vllm/config/model.py:ModelConfig.dtype`
- Этап применения: сборка `VllmConfig` → загрузка весов → все forward'ы; косвенно — расчёт KV-cache

## Что меняет в движке

**Откуда берётся `config_dtype`.** `ModelArchConfigConvertorBase.get_torch_dtype` пробует по порядку: `hf_config.dtype`, `hf_config.get_text_config().dtype`, `vision_config.dtype`, `encoder_config.dtype`, и в последнюю очередь — метаданные safetensors самих весов.

**Разрешение `auto`** (`_resolve_auto_dtype`):

1. берётся `current_platform.supported_dtypes`, из него выкидываются типы, запрещённые для этого `model_type`;
2. `preferred_dtype = supported_dtypes[0]`, кроме pooling-моделей, где предпочитается `torch.float16`, если он поддержан;
3. если `config_dtype == float32`, он заменяется на `preferred_dtype` — то есть FP32-чекпоинт **не** остаётся в FP32;
4. если получившийся `config_dtype` есть в списке поддержанных — он и берётся;
5. иначе пишется предупреждение `Your device 'NVIDIA ...' (with compute capability 7.5) doesn't support torch.bfloat16. Falling back to torch.float16 for compatibility.` и берётся `preferred_dtype`.

Списки платформ (`vllm/platforms/cuda.py`): compute capability ≥ 8.0 (Ampere, Ada, Hopper, Blackwell) ⇒ `[bfloat16, float16, float32]`; 6.0–7.5 (Pascal, Volta, Turing) ⇒ `[float16, float32]`; ниже ⇒ `[float32]`. Порядок значим: первый элемент и есть `preferred_dtype`.

**Отсюда расхождение со справкой.** Текст обещает, что `auto` даст FP16 для FP32- и FP16-моделей. Фактически на Ampere и новее `preferred_dtype` — это BF16, поэтому FP32-чекпоинт приезжает в **BF16**. FP16-чекпоинт остаётся FP16 (он есть в списке поддержанных). Справка описывает поведение до появления BF16 в списке и в этом commit'е checkout'а устарела.

**Явное значение.** Строка приводится к нижнему регистру и мапится через `_STR_DTYPE_TO_TORCH_DTYPE` (`half`/`float16` → fp16, `float`/`float32` → fp32, `bfloat16` → bf16). Затем `_check_valid_dtype` бьёт по чёрному списку `_FLOAT16_NOT_SUPPORTED_MODELS` (в этом commit'е — `gemma2`, `gemma3`, `gemma3_text`, `glm4`) с текстом «The model type 'gemma3' does not support float16. Reason: Numerical instability. Please use bfloat16 or float32 instead.» Наконец, при расхождении с `config_dtype` печатается одно из: `Upcasting %s to %s.`, `Downcasting %s to %s.`, `Casting %s to %s.`

**Голова модели.** `ModelConfig.head_dtype` считается отдельно (`_get_head_dtype`): берётся `hf_config.head_dtype`, значение `"model"` означает «как у модели». Переопределяется через `--hf-overrides '{"head_dtype": "float32"}'`, а не через `--dtype`. Если платформа не поддерживает полученный тип головы, он откатывается к `self.dtype` с логом `The current platform does not support [%s] head dtype, fallback to model dtype [%s].`

## Значения и формат

- `auto` — см. выше. На управляемом сервере лучше фиксировать явно: результат зависит от карты, и перенос инстанса на другое железо молча меняет численность.
- `half` = `float16`. 2 байта на параметр.
- `bfloat16` — 2 байта, шире диапазон, меньше мантисса. Стандарт для современных LLM.
- `float` = `float32`. 4 байта: удвоение памяти весов и (при `--kv-cache-dtype auto`) KV-cache. Практически — только для отладки численных проблем и для маленьких моделей.
- Значения регистронезависимы (`dtype.lower()`), неизвестное даёт `ValueError: Unknown dtype: '...'` — но до этого argparse отбракует его по `choices`.
- Для квантованных весов `--dtype` задаёт тип активаций и вычислений; тип хранения весов диктует метод квантизации. Справка рекомендует `half` для AWQ.

## Когда использовать

- **Всегда задавайте явно** на управляемом сервере: `auto` зависит от compute capability карты и от типа в конфиге модели, а оценка памяти инстанса в arriero опирается на предсказуемый размер весов (`docs/MEMORY_ESTIMATION.md`).
- `bfloat16` — дефолтный выбор для Ampere и новее.
- `float16` — на Turing/Volta (BF16 не поддержан аппаратно) и там, где так рекомендует метод квантизации.
- `float32` — только для локализации численной нестабильности; на серьёзной модели это удвоение VRAM и заметная просадка throughput.
- Не пытайтесь через `--dtype` «поднять точность» квантованной модели: веса всё равно распакуются согласно своему методу.

## Влияние на производительность и память

- **Веса.** Прямо пропорционально: `num_params × байт_на_параметр`. Переход fp16/bf16 → fp32 удваивает объём весов на каждой карте.
- **KV-cache.** При `--kv-cache-dtype auto` тип KV-cache наследуется от типа модели, поэтому `--dtype float32` удваивает и байты на токен KV-cache, вдвое сокращая `Maximum concurrency` при том же `--gpu-memory-utilization`.
- **Активации.** Пик активаций, измеренный профилированием, тоже растёт вдвое при FP32 — а это вычитается из бюджета до KV-cache.
- **Скорость.** FP16/BF16 идут по тензорным ядрам; FP32 на них не идёт (на Turing для FP32-matmul chunked-prefill triton-ядер vLLM даже переключается на `ieee`-точность с отдельным предупреждением). Разница в throughput кратная, а не процентная.
- **Время старта.** Не влияет заметно; апкаст/даункаст выполняется при загрузке весов.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype`: при `auto` берёт тип модели. Чтобы разорвать связь (модель в BF16, KV-cache в FP8), задайте его явно.
- `--quantization` и `--quantization-config`: определяют хранение весов; `--dtype` — вычислительный тип вокруг них.
- `--gpu-memory-utilization`: бюджет фиксирован, а `--dtype` меняет, сколько от него съедят веса и активации; всё остальное уходит в KV-cache.
- `--max-model-len`, `--max-num-seqs`: спрос на KV-cache, чья цена за токен зависит от типа.
- `--hf-overrides`: единственный способ управлять `head_dtype`.
- `--override-attention-dtype`: отдельный ROCm-специфичный переопределитель; на не-ROCm платформе выдаёт предупреждение «override-attention-dtype is set but not using ROCm platform».

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: The model type 'gemma3' does not support float16. Reason: Numerical instability. Please use bfloat16 or float32 instead.` **Причина:** явный `--dtype half/float16` на модели из чёрного списка. **Лечение:** `bfloat16`.
- **Симптом:** предупреждение `Your device 'NVIDIA GeForce RTX 2080 Ti' (with compute capability 7.5) doesn't support torch.bfloat16. Falling back to torch.float16 for compatibility.` **Причина:** BF16-чекпоинт на до-Ampere карте. **Действие:** штатный откат; проверьте качество на своей задаче.
- **Симптом:** OOM на старте после переноса конфигурации на другую машину без изменения флагов. **Причина:** `auto` разрешился в другой тип (или KV-cache стал шире). **Лечение:** зафиксировать `--dtype` явно.
- **Симптом:** в логе `Upcasting torch.float16 to torch.float32.` или `Casting torch.bfloat16 to torch.float16.` **Причина:** ваш `--dtype` отличается от типа чекпоинта. **Действие:** убедиться, что это намеренно — приведение типа влияет на качество.
- **Подтверждение принятого значения:** строка стартового конфига содержит `dtype=torch.bfloat16` (`VllmConfig.__str__`); рядом видны `Available KV cache memory` и `GPU KV cache size`, по которым проверяется итоговая арифметика.

## Примеры

```bash
vllm serve /models/Qwen3-4B --dtype bfloat16 --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --dtype bfloat16 --kv-cache-dtype fp8 --max-num-seqs 8
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/vllm/transformers_utils/model_arch_config_convertor.py`
- `vllm/vllm/config/vllm.py`
- `docs/MEMORY_ESTIMATION.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
