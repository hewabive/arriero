---
schema: 1
engine: sglang
primaryName: "--quantization-param-path"
title: "--quantization-param-path"
summary: Путь к JSON с масштабами KV-кеша для `--kv-cache-dtype fp8_e4m3`. Читается только при этом одном значении dtype и только моделями, реализовавшими `load_kv_cache_scales`; ошибки чтения не останавливают старт, а молча дают масштабы 1.0.
group: model
related:
  - --kv-cache-dtype
  - --quantization
  - --tp-size
  - --dtype
---

# --quantization-param-path

## Кратко

Аргумент относится не к весам, а к KV-кешу: он указывает файл с per-layer масштабирующими коэффициентами, которые нужны при хранении KV в `fp8_e4m3`. Условие срабатывания узкое — эффективный `--kv-cache-dtype` должен быть ровно `fp8_e4m3`, а класс модели должен реализовывать `load_kv_cache_scales`. Без файла движок предупредит и возьмет масштабы 1.0, что для FP8 KV означает заметный риск деградации качества на длинном контексте.

## Оригинальная справка

```text
Path to the JSON file containing the KV cache scaling factors. This should generally be supplied, when KV cache dtype is FP8. Otherwise, KV cache scaling factors default to 1.0, which may cause accuracy issues. 
```

## Паспорт аргумента

- Флаги: `--quantization-param-path`
- Группа: `model`
- Тип значения: путь к JSON-файлу (`Optional[str]`, парсер `nullable_str`)
- Допустимые значения: не ограничены `choices`; фактически — путь к файлу схемы `QuantParamSchema`
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; ни один `_handle_*` в `ServerArgs.__post_init__` это поле не трогает
- Где объявлен: `ServerArgs.quantization_param_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: после загрузки весов модели, в `load_kv_cache_scales` (`sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`)

## Что меняет в движке

`load_kv_cache_scales` вызывается один раз на воркер после того, как веса уже в памяти:

- если разрешенный `kv_cache_dtype` **не** равен `fp8_e4m3`, аргумент не читается вообще;
- если равен `fp8_e4m3`, но путь не задан — в лог уходит `Using FP8 KV cache but no scaling factors provided. Defaulting to scaling factors of 1.0. This may lead to less accurate results!`;
- если путь задан, но у класса модели нет метода `load_kv_cache_scales` — поднимается `RuntimeError` и старт останавливается.

Сам файл читает `kv_cache_scales_loader` (`sglang/python/sglang/srt/model_loader/weight_utils.py`). Он валидирует содержимое pydantic-схемой `QuantParamSchema` с контекстом `{model_type, num_hidden_layers, tp_rank, tp_size}` и возвращает пары `(layer_idx, scale)` для **текущего** TP-ранга. Модель раскладывает их в `attn.k_scale`/`attn.v_scale` соответствующего слоя.

Метод `load_kv_cache_scales` реализован не везде. В checkout'е его имеют `llama`, `qwen2`, `qwen3`, `mimo`, `mimo_v2`, `apertus`, `arcee`, `exaone4`, `glm4`, `hunyuan`, `opt`, `solar` (`sglang/python/sglang/srt/models/`). Для любой другой архитектуры задание пути — это гарантированный `RuntimeError` на старте.

## Значения и формат

- Формат файла: JSON вида `{"model_type": "<тип>", "kv_cache": {"dtype": "float8_e4m3fn", "scaling_factor": {"<tp_rank>": {"<layer_idx>": <float>, ...}, ...}}}`.
- Проверки схемы жесткие: `dtype` обязан быть строкой `float8_e4m3fn`; число ключей в `scaling_factor` должно совпадать с текущим `--tp-size`; в каждом ранге должны присутствовать все слои `0..num_hidden_layers-1`; `model_type` должен совпасть с типом модели.
- Пустая строка и литерал `None` благодаря `nullable_str` разбираются как «не задано».
- **Ошибки чтения не фатальны.** `kv_cache_scales_loader` ловит `FileNotFoundError`, `json.JSONDecodeError` и любое `Exception` (включая падения валидаторов схемы), печатает `logger.error` плюс предупреждение `Defaulting to KV cache scaling factors = 1.0 for all layers in TP rank <n> as an error occurred during loading.` и возвращает пустой список. Сервер поднимется с неправильными масштабами — это самая опасная точка аргумента.
- Файл читается каждым TP-рангом отдельно, значит он должен быть доступен по одному и тому же пути на всех узлах.

## Когда использовать

- Включен `--kv-cache-dtype fp8_e4m3` на поддерживаемой архитектуре, и есть посчитанные масштабы (обычно их выдает тот же инструмент, что квантовал модель). Без них FP8 KV работает с масштабами 1.0 и на длинном контексте деградирует по качеству.
- Не задавайте при `--kv-cache-dtype auto`, `bf16`, `fp8_e5m2`, `mxfp8`, `nvfp4` и прочих значениях: файл будет просто проигнорирован, и вы получите ложное ощущение, что масштабы применены.
- Не задавайте, если не уверены в архитектуре: на модели без `load_kv_cache_scales` это отказ старта, а не тихая деградация.

## Влияние на производительность и память

На память и скорость не влияет: файл читается один раз при старте, а масштабы — это по одному float на слой. Экономию памяти дает `--kv-cache-dtype fp8_e4m3`, а не этот аргумент; здесь речь только о качестве результатов при уже включенном FP8-кеше.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype`: единственный включатель. Значение должно быть ровно `fp8_e4m3`.
- `--tp-size`: число рангов в файле обязано совпадать с текущим TP; файл, посчитанный под TP 1, не подойдет для TP 2.
- `--quantization`: независимая ось (веса против KV-кеша). Одинаковое слово «quantization» в именах не означает связи.

## Типовые проблемы и диагностика

- `RuntimeError: Using FP8 KV cache and scaling factors provided but model <класс> does not support loading scaling factors.` — архитектура не реализует `load_kv_cache_scales`. Снимите аргумент.
- `File or directory '<path>' not found.` плюс `Defaulting to KV cache scaling factors = 1.0 ...` — путь неверный, сервер поднялся без масштабов. Проверяйте лог на старте, а не только код возврата.
- `Error decoding JSON in file '<path>'.` — битый JSON, тот же тихий откат к 1.0.
- `An error occurred while reading '<path>'.` — сработал валидатор схемы: несовпадение `model_type`, числа слоев, `dtype` или числа TP-рангов. Точную причину в этой ветке не печатают, поэтому проверяйте схему вручную.
- Строка `Loaded KV cache scaling factors from <path>` — единственное подтверждение, что файл действительно применен.
- Подтверждение принятого значения аргумента — дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --kv-cache-dtype fp8_e4m3 --quantization-param-path /models/scales/llama31-8b-kv-scales.json
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --tp-size 2 --kv-cache-dtype fp8_e4m3 --quantization-param-path /shared/scales/qwen3-8b-tp2.json
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/models/llama.py`
- `sglang/docs/docs/advanced_features/quantized_kv_cache.mdx`
