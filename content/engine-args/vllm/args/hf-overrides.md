---
schema: 1
engine: vllm
primaryName: "--hf-overrides"
title: "--hf-overrides"
summary: Точечные правки конфига модели перед тем, как vLLM начнёт из него что-либо выводить. Стандартный рецепт для reranker'ов, для моделей без `architectures` и для полей вроде `head_dtype`.
group: ModelConfig
related:
  - --hf-config-path
  - --config-format
  - --convert
  - --max-model-len
  - --dtype
  - --model-class-overrides
---

# --hf-overrides

## Кратко

`--hf-overrides` подменяет поля HF-конфига до того, как vLLM определит архитектуру, посчитает `max_model_len` и решит, какой класс модели грузить. Это самый ранний рычаг влияния на конфигурацию — и самый острый: одним ключом можно увести движок на совершенно другую реализацию.

Аргумент JSON-типа, поэтому принимает и строку JSON, и точечные под-флаги.

## Оригинальная справка

```text
If a dictionary, contains arguments to be forwarded to the Hugging Face
config. If a callable, it is called to update the HuggingFace config.
```

## Паспорт аргумента

- Флаги: `--hf-overrides`
- Группа argparse: `ModelConfig`
- Тип значения: JSON-объект (в Python-API также callable `PretrainedConfig -> PretrainedConfig`)
- Допустимые значения: не ограничены — ключи и значения передаются в HF-конфиг как есть; парсер CLI (`union_dict_and_str`) принимает строку, похожую на `{...}`, и разбирает её как JSON, а любую другую строку пропускает как строку, что дальше приведёт к ошибке
- Значение по умолчанию: `field(default_factory=dict)` — то есть пустой словарь, правок нет
- Эффективное значение: не переопределяется; форма callable доступна только из Python-API, на CLI её задать нельзя
- Где объявлен: `vllm/config/model.py:ModelConfig.hf_overrides`
- Этап применения: `ModelConfig.__post_init__` → `get_config()`, самый ранний шаг сборки конфига

## Что меняет в движке

**Разделение на два вида правок.** В начале `__post_init__` словарь делится:

```
for key, value in self.hf_overrides.items():
    if isinstance(value, dict): dict_overrides[key] = value
    else: hf_overrides_kw[key] = value
```

- **Плоские значения** (`hf_overrides_kw`) уходят прямо в `get_config(..., hf_overrides_kw=...)` и дальше в `PretrainedConfig.get_config_dict` / `AutoConfig.from_pretrained` как обычные kwargs — то есть применяются **при построении** объекта конфига.
- **Словарные значения** (`dict_overrides`) применяются **после** построения через `_apply_dict_overrides` → `_update_nested`: если у конфига есть одноимённый вложенный `PretrainedConfig` (`text_config`, `vision_config`), он обновляется рекурсивно; иначе значение просто присваивается как dict-поле.

**Особый случай `model_type`.** `HFConfigParser.parse` вытаскивает `model_type` из overrides до всего остального, чтобы выбрать нужный класс конфига из `_CONFIG_REGISTRY` и активировать патчи (`_PATCH_HF_VALIDATE_ROPE`, `_PATCH_HF_ALLOWED_LAYER_TYPES`). Для callable-формы это делается через фиктивный конфиг с `dummy_`-префиксом.

**Что зависит от результата.** Всё: `architectures` (а значит выбранный класс модели), `max_position_embeddings` и rope-параметры (а значит `max_model_len` и размер KV-cache), `quantization_config`, `head_dtype`, `num_labels` для классификационных голов, флаги matryoshka для эмбеддеров.

Типовые рецепты из апстрим-документации:

- `--hf-overrides '{"architectures": ["GPT2LMHeadModel"]}'` — конфиг без `architectures` (иначе в логе `Model config does not have a top-level 'architectures' field: expecting hf_overrides={'architectures': ['...']} to be passed in engine args.`);
- reranker'ы: `'{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}'` вместе с `--convert classify`;
- `'{"is_matryoshka": true}'` или `'{"matryoshka_dimensions": [...]}'` для эмбеддеров, не опознанных как matryoshka;
- `'{"head_dtype": "float32"}'` — единственный способ поднять точность `lm_head`, `--dtype` для этого не подходит.

## Значения и формат

Две эквивалентные формы записи (общее свойство JSON-аргументов `FlexibleArgumentParser`):

- одной строкой: `--hf-overrides '{"architectures": ["Qwen3ForSequenceClassification"], "num_labels": 2}'`;
- точечными под-флагами: `--hf-overrides.num_labels 2 --hf-overrides.architectures+ Qwen3ForSequenceClassification` (суффикс `+` добавляет элемент в список, `+=` принимает список через запятую).

Дополнительно:

- вложенные словари поддерживаются обеими формами: `--hf-overrides '{"text_config": {"rope_theta": 1000000}}'` и `--hf-overrides.text_config.rope_theta 1000000`;
- значение, не похожее на JSON-объект, парсер пропустит как обычную строку, и `__post_init__` упадёт при попытке вызвать `.items()` — то есть `--hf-overrides foo` не работоспособен;
- `--config` (YAML) подставляет значения **до** явных флагов, поэтому явный `--hf-overrides` в командной строке выигрывает.

## Когда использовать

- Модель не опознаётся: нет `architectures` или указан класс, которого vLLM не знает.
- Конвертация reranker'а/классификатора — стандартный рецепт, без него `--convert classify` не соберёт правильную голову.
- Нужно поднять точность головы (`head_dtype`) или включить флаги, которые движок не выводит из конфига автоматически.
- Форсировать `max_position_embeddings`/rope, если конфиг занижает возможности модели, — но осознавая, что это меняет расчёт памяти.
- **Не используйте** как замену `--max-model-len`: длину можно задать напрямую, не трогая конфиг.
- **Не подгоняйте конфиг под ошибку загрузки наугад.** Правка `architectures` меняет класс модели целиком; неправильный выбор даёт либо ошибку формы, либо тихо неверные результаты.

## Влияние на производительность и память

Само применение правок бесплатно. Влияние идёт через то, что вы правите: `max_position_embeddings` и rope-скейлинг задают `max_model_len` и через него — сколько KV-cache нужно на один запрос; `head_dtype: "float32"` увеличивает память и стоимость логит-слоя; смена `architectures` может привести к совершенно другому профилю VRAM. Проверяйте эффект по строкам `Using max model len N` и `GPU KV cache size: N tokens, Maximum concurrency ...`.

## Взаимодействие с другими аргументами

- `--hf-config-path`: задаёт **источник** конфига; overrides применяются к тому, что оттуда прочитано. Комбинируются свободно.
- `--config-format`: определяет парсер; `model_type` из overrides участвует в выборе класса конфига внутри `hf`-парсера.
- `--convert`: правки конфига — обязательный спутник `--convert classify` для reranker'ов.
- `--max-model-len`: прямой и предсказуемый способ задать длину; через overrides то же самое достигается косвенно и опаснее.
- `--dtype`: не управляет `head_dtype`; это делает только `--hf-overrides`.
- `--model-class-overrides`: соседний, но другой механизм — подменяет класс реализации по имени архитектуры, а не поля конфига.

## Типовые проблемы и диагностика

- **Симптом:** `Model config does not have a top-level 'architectures' field: expecting hf_overrides={'architectures': ['...']} to be passed in engine args.` **Причина:** конфиг без архитектуры и без записи в `MODEL_MAPPING_NAMES`. **Лечение:** задать `architectures` через overrides.
- **Симптом:** `AttributeError`/`TypeError` в `__post_init__` сразу после старта. **Причина:** значение флага не разобралось как JSON (кавычки съела оболочка, значение не начинается с `{`). **Лечение:** одиночные кавычки вокруг JSON либо точечная форма под-флагов.
- **Симптом:** правка вложенного поля не применилась. **Причина:** вы передали плоский ключ вместо вложенного словаря — плоские значения уходят в `from_pretrained` и могут быть проигнорированы `transformers`. **Лечение:** оформить как вложенный словарь (`{"text_config": {...}}`), тогда сработает `_update_nested`.
- **Симптом:** после правки `max_position_embeddings` инстанс перестал стартовать по памяти. **Причина:** вырос `max_model_len` и требование KV-cache на один запрос. **Проверка:** сообщение «To serve at least one request with the model's max seq len (N) ... estimated maximum model length is M».
- **Подтверждение принятого значения:** `Resolved architecture: <Arch>` и `Using max model len N` в логе старта.

## Примеры

```bash
vllm serve Qwen/Qwen3-Reranker-0.6B --convert classify --hf-overrides '{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}'
```

```bash
vllm serve /models/Qwen3-4B --hf-overrides.head_dtype float32 --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/docs/configuration/model_resolution.md`
- `vllm/docs/models/pooling_models/scoring.md`
- `vllm/docs/models/pooling_models/embed.md`
