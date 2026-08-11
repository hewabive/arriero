---
schema: 1
engine: sglang
primaryName: "--speculative-draft-model-quantization"
title: "--speculative-draft-model-quantization"
summary: Метод квантизации для весов draft-модели. Не задан — наследуется `--quantization` целевой модели, что почти всегда неверно для FP4/FP8-чекпоинтов с неквантованной MTP-головой; `unquant` — способ явно сказать «draft грузить без квантизации».
group: spec
related:
  - --quantization
  - --speculative-draft-model-path
  - --speculative-draft-load-format
  - --speculative-algorithm
  - --dtype
  - --modelopt-quant
---

# --speculative-draft-model-quantization

## Кратко

Draft-модель — отдельный чекпоинт со своим форматом весов, и по умолчанию SGLang просто копирует ей `--quantization` от target'а. Это удобно, когда draft лежит в том же формате, и вредно, когда MTP-голова внутри FP4-чекпоинта осталась в bf16. Аргумент даёт draft'у собственное значение; специальное `unquant` означает «никакой квантизации», а не «авто».

## Оригинальная справка

```text
The quantization method for speculative model.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-model-quantization`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения (из `choices`): `awq`, `fp8`, `mxfp8`, `gptq`, `marlin`, `gptq_marlin`, `awq_marlin`, `bitsandbytes`, `gguf`, `modelopt`, `modelopt_fp8`, `modelopt_fp4`, `nvfp4_online`, `modelopt_mixed`, `petit_nvfp4`, `w8a8_int8`, `w8a8_fp8`, `moe_wna16`, `w4afp8`, `mxfp4`, `auto-round`, `auto-round-int8`, `compressed-tensors`, `modelslim`, `mxfp_w4a8`, `quark`, `quark_int4fp8_moe`, `quark_mxfp4`, `mlx_q4`, `mlx_q8`, `unquant`, `humming`. Это общий список методов SGLang; какие из них реально работают, зависит от железа и установленных пакетов (на ROCm поддерживается заметно меньший набор)
- Значение по умолчанию: `null`
- Эффективное значение: в `_handle_missing_default_values` при `None` подставляется `--quantization`; значение `unquant` затем превращается в `None` (то есть «грузить как есть»). Факт того, что оператор задал аргумент явно, запоминается во внутреннем поле `_speculative_draft_quantization_explicitly_set` (без CLI-поверхности) и позже позволяет online-квантизации draft'а победить автодетект чекпоинта
- Где объявлен: `ServerArgs.speculative_draft_model_quantization`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_missing_default_values`) → `ModelConfig.from_server_args(..., is_draft_model=True)` → `_verify_quantization` → загрузка весов draft-воркера

## Что меняет в движке

`ModelConfig.from_server_args` подставляет в поле `quantization` draft-конфига именно это значение (для target'а — `--quantization`). Дальше `_verify_quantization` сверяет его с `quantization_config` из hf-конфига draft-чекпоинта, и здесь поведение draft'а отличается от target'а:

- если значения совместимы (таблица `compatible_quantization_methods`), выигрывает CLI-значение;
- если несовместимы, **для draft-модели ошибка не выбрасывается**: движок печатает `Draft model quantization (X) differs from main model quantization (Y). Using draft model's detected quantization: X` и берёт формат из чекпоинта. У target'а тот же случай — это `ValueError`;
- исключение — `nvfp4_online` на `modelopt_fp4`-чекпоинте: явный opt-in draft'а сохраняется, и `_resolve_explicit_draft_quant_config` (`model_loader/weight_utils.py`) переводит уже упакованный конфиг в онлайновую квантизацию весов, но только если аргумент был задан **явно** (то самое `_speculative_draft_quantization_explicitly_set`).

Несколько NPU-моделей (`qwen3_next_mtp`, `qwen3_5_mtp`, `glm4_moe_nextn`, `glm4_moe_lite_nextn`) отдельно проверяют `speculative_draft_model_quantization is None` и в этом случае строят MTP-слой вовсе без quant-конфига.

## Значения и формат

- Одно значение из `choices`; регистр приводится к нижнему уже в `_verify_quantization`.
- `unquant` — не метод, а отрицание: после разбора оно становится `None`, то есть «никакой квантизации, даже унаследованной от `--quantization`». Единственный способ загрузить bf16-draft рядом с FP8-target'ом, не полагаясь на автодетект.
- Не задавать = наследовать `--quantization`. «Авто» здесь нет: автодетект по чекпоинту случается уже внутри `_verify_quantization`, и для draft'а он побеждает несовместимое CLI-значение.
- Значение вне `choices` отвергает argparse; значение, неизвестное реестру методов, — `ValueError: Unknown quantization method: …`.

## Когда использовать

- Target квантован (FP8/FP4/AWQ), а draft — обычный bf16-чекпоинт: `--speculative-draft-model-quantization unquant`. Без этого draft получит формат target'а и в лучшем случае будет молча переопределён автодетектом, в худшем — упадёт на загрузчике.
- Нужна онлайновая FP4-квантизация именно draft-весов на `modelopt_fp4`-чекпоинте: `nvfp4_online` работает только заданный явно.
- Не трогать, когда target и draft — части одного чекпоинта (MTP): формат там один и наследование корректно.

## Влияние на производительность и память

- VRAM: прямо определяет объём draft-весов. Разница между bf16 и FP8 draft'а на MTP-голове — сотни мегабайт, на STANDALONE-модели — единицы гигабайт.
- Скорость: у draft'а свои ядра; неудачно выбранный метод (не из списка оптимизированных) даёт медленный draft-шаг, а это прямой вычет из выигрыша спекуляции.
- Время старта: онлайновая квантизация (`nvfp4_online`, requantization) добавляет проход по весам.
- На KV-пул не влияет: тип KV-кеша задаётся `--kv-cache-dtype`, а не этим аргументом.

## Взаимодействие с другими аргументами

- `--quantization`: источник значения по умолчанию. Обратите внимание, что `--quantization unquant` для target'а тоже превращается в `None`, и это происходит **после** копирования значения в draft.
- `--speculative-draft-model-path`: без него аргумент ни на что не влияет.
- `--speculative-draft-load-format`: формат файлов (safetensors/gguf/dummy) — независимая ось от метода квантизации.
- `--dtype`: общий на оба воркера; определяет тип неквантованных тензоров.
- `--speculative-algorithm`: у `NGRAM` draft-весов нет, аргумент бесполезен.

## Типовые проблемы и диагностика

- `Draft model quantization (fp8) differs from main model quantization (modelopt_fp4). Using draft model's detected quantization: fp8` — не ошибка, а сообщение о том, что ваше (или унаследованное) значение проигнорировано в пользу чекпоинта.
- `Unknown quantization method: …` — значение не поддержано сборкой; проверьте `python -m sglang.launch_server --help` установленной версии.
- `… quantization is currently not supported in ROCm` — метод есть в `choices`, но не в ROCm-списке.
- Ошибка загрузчика вида «weights are already packed» при `nvfp4_online` — draft-веса уже квантованы; уберите онлайн-режим.
- Что смотреть: дамп `server_args=` (принятое значение), строки `_verify_quantization` в логе старта, размер занятой памяти после загрузки draft-воркера.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3-FP8 --quantization fp8 --speculative-algorithm EAGLE --speculative-draft-model-quantization unquant
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B-FP8 --quantization fp8 --speculative-algorithm STANDALONE --speculative-draft-model-path /models/Llama-3.2-1B-Instruct --speculative-draft-model-quantization unquant --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/models/qwen3_next_mtp.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
- `sglang/docs/docs/advanced_features/quantization.mdx`
