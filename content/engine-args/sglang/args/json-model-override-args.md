---
schema: 1
engine: sglang
primaryName: "--json-model-override-args"
title: "--json-model-override-args"
summary: JSON-строка, поля которой накладываются на HF-конфиг модели после его разбора. Основной инструмент для YaRN-расширения контекста, урезания модели под бенчмарк и включения модельных фич, у которых нет своего флага.
group: model
related:
  - --model-path
  - --context-length
  - --model-config-parser
  - --trust-remote-code
  - --load-format
  - --revision
  - --is-embedding
---

# --json-model-override-args

## Кратко

`--json-model-override-args` — это патч поверх `config.json` модели. Строка парсится `json.loads` и применяется в `get_config()` **после** того, как выбранный парсер построил объект конфига: каждое поле присваивается через `setattr`, а словарь поверх вложенного `PretrainedConfig` — через `update`. Отсюда весь спектр применений: расширение RoPE под большой контекст, урезание числа слоев для профилирования, включение фич вроде matryoshka-эмбеддингов и `index_topk_pattern`. Ошибок «неизвестное поле» здесь нет: движок положит в конфиг что угодно, а последствия проявятся позже.

## Оригинальная справка

```text
A dictionary in JSON string format used to override default model configurations.
```

## Паспорт аргумента

- Флаги: `--json-model-override-args`
- Группа: `model`
- Тип значения: строка с JSON-объектом
- Допустимые значения: любой валидный JSON-объект; ключи не проверяются
- Значение по умолчанию: `"{}"` (пустой объект)
- Эффективное значение: не переопределяется движком; строка разбирается несколько раз — в `ModelConfig` и в спекулятивном хуке для draft-модели
- Где объявлен: `ServerArgs.json_model_override_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение `ModelConfig` (то есть до любых расчетов памяти и до выбора backend'ов)

## Что меняет в движке

`ModelConfig.__init__` делает `self.model_override_args = json.loads(model_override_args)` и передает словарь в `get_config()` (`sglang/python/sglang/srt/utils/hf_transformers/config.py`). Там, уже после работы парсера (`hf` или `mistral`):

```python
for key, value in model_override_args.items():
    current = getattr(config, key, None)
    if isinstance(value, dict) and isinstance(current, PretrainedConfig):
        current.update(value)
    else:
        setattr(config, key, value)
```

Два следствия, которые чаще всего кусаются:

- **Вложенные конфиги мультимодальных моделей.** Если поле уже является `PretrainedConfig` (например `text_config`), словарь **сливается** с ним. Если такого поля нет, словарь ляжет как обычный `dict`, и код, ожидающий атрибуты, сломается.
- **Порядок.** Переопределение применяется до того, как `get_hf_text_config()` выделит текстовую часть конфига и до `_derive_context_length`. Поэтому переписанный `rope_scaling` немедленно влияет на выведенную длину контекста.

Тот же словарь отдельно читается для спекулятивного декодирования (`arg_groups/speculative_hook.py`) — то есть override применяется и к резолву draft-модели.

## Значения и формат

- Значение — **одна строка**, поэтому в shell её нужно брать в одинарные кавычки: `--json-model-override-args '{"num_hidden_layers": 2}'`.
- Невалидный JSON падает не в argparse, а позже, при построении `ModelConfig`: `json.decoder.JSONDecodeError`.
- Пустой объект `{}` — то же самое, что не задавать аргумент.
- Ключи — это имена полей HF-конфига, а не аргументы SGLang. `{"context_length": 4096}` не сделает ничего осмысленного; для длины контекста есть `--context-length` и поля `max_position_embeddings` / `rope_scaling`.
- Значения типов JSON отображаются напрямую: числа, строки, списки, объекты.

## Когда использовать

- **YaRN и другие rope-расширения.** Канонический рецепт апстрима: `'{"rope_scaling":{"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":262144}}'` вместе с `--context-length` и `SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1`.
- **Профилирование.** `'{"num_hidden_layers": 1, "num_key_value_heads": 1}'` с `--load-format dummy` дает крошечную модель нужной архитектуры без чтения весов.
- **Фичи, у которых нет флага.** matryoshka-эмбеддинги (`matryoshka_dimensions`), `index_topk_pattern` для GLM, `video_pruning_rate` для видео-моделей — всё это поля конфига.
- **Не используйте** для того, что уже есть отдельным аргументом: `--context-length`, `--dtype`, `--quantization`. Тихое расхождение двух источников правды разбирать потом тяжело.

## Влияние на производительность и память

Само по себе наложение полей бесплатно, но через конфиг аргумент влияет на всё: число слоев и голов определяет размер весов и `cell_size` KV-пула, `rope_scaling` — выведенную длину контекста, а значит и `req_to_token`-пул. Урезание слоев для бенчмарка меняет расход VRAM на порядки — это и есть его смысл.

## Взаимодействие с другими аргументами

- `--context-length`: единственный корректный способ поднять контекст — сначала переписать `rope_scaling` здесь, потом задать длину там.
- `--model-config-parser`: override применяется после парсера; при `mistral`-парсере поля кладутся на разобранный конфиг Mistral, а не на `config.json`.
- `--load-format dummy`: типичная пара для профилирования урезанной модели.
- `--trust-remote-code`: если модель приносит собственный класс конфига, override ложится уже на него.
- `--is-embedding`: `matryoshka_dimensions` задается именно здесь, если его нет в конфиге модели.
- `--decrypted-config-file`: задает, какой файл конфига читать; override применяется поверх результата.

## Типовые проблемы и диагностика

- `json.decoder.JSONDecodeError` при старте — сломанные кавычки. Почти всегда причина в том, что строка не взята в одинарные кавычки и shell съел двойные.
- Поле «применилось», но эффекта нет — вы переписали поле верхнего уровня у мультимодальной модели, тогда как читается оно из `text_config`. Кладите словарь в соответствующую вложенную секцию.
- Изменили `rope_scaling`, а выведенная длина контекста не выросла — в `get_context_length` множитель `factor` принудительно сбрасывается в 1, если в `rope_scaling` присутствует `original_max_position_embeddings` или `rope_type == "llama3"`. Это ожидаемо: длину в таком случае задают явным `--context-length`.
- Проверить, что строка вообще дошла до движка, можно по дампу `server_args=` при старте; результат применения виден косвенно — по `context_len=…` в стартовой строке планировщика и по размеру весов в `Load weight end.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Embedding-0.6B --is-embedding --json-model-override-args '{"matryoshka_dimensions": [128, 256, 512, 1024, 1536]}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --load-format dummy --json-model-override-args '{"num_hidden_layers": 2, "num_key_value_heads": 1}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/common.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/docs/docs/developer_guide/benchmark_and_profiling.mdx`
- `sglang/docs/docs/supported-models/embedding_models.mdx`
- `sglang/docs/cookbook/autoregressive/Qwen/Qwen3-Next.mdx`
