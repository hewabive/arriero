---
schema: 1
engine: sglang
primaryName: "--decrypted-draft-config-file"
title: "--decrypted-draft-config-file"
summary: То же, что `--decrypted-config-file`, но для draft-модели спекулятивного декодирования: имя файла конфигурации, читаемого вместо `config.json`. Влияет и на резолв алгоритма спекуляции.
group: model
related:
  - --decrypted-config-file
  - --speculative-draft-model-path
  - --speculative-algorithm
  - --model-config-parser
  - --speculative-draft-load-format
---

# --decrypted-draft-config-file

## Кратко

Аргумент — draft-половина пары с `--decrypted-config-file`. Он подставляется как `_configuration_file` при чтении конфигурации **draft-модели**, то есть говорит transformers читать указанный файл вместо `config.json`. Отличие от целевой половины: значение читается дополнительно на более раннем шаге — при резолве алиаса `--speculative-algorithm`, до построения `ModelConfig`. Без спекулятивного декодирования аргумент полностью инертен.

## Оригинальная справка

```text
The path of the decrypted draft config file.
```

## Паспорт аргумента

- Флаги: `--decrypted-draft-config-file`
- Группа: `model`
- Тип значения: строка
- Допустимые значения: не ограничены; смысл имеет имя файла, разрешимое относительно `--speculative-draft-model-path`
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; пустая строка и пробелы эквивалентны отсутствию (`if override_config_file and override_config_file.strip()`)
- Где объявлен: `ServerArgs.decrypted_draft_config_file`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, узкая интеграция со схемой шифрованных чекпоинтов
- Этап применения: `handle_speculative_decoding` в `__post_init__` (резолв алгоритма) и построение `ModelConfig` draft-модели

## Что меняет в движке

Две точки чтения.

1. `sglang/python/sglang/srt/arg_groups/speculative_hook.py`:

```python
override_config_file = server_args.decrypted_draft_config_file
if override_config_file and override_config_file.strip():
    kwargs["_configuration_file"] = override_config_file.strip()
server_args.speculative_algorithm = _resolve_speculative_algorithm_alias(
    server_args.speculative_algorithm, server_args.speculative_draft_model_path,
    trust_remote_code=server_args.trust_remote_code, kwargs=kwargs,
)
```

То есть без этого аргумента резолв алгоритма по конфигу draft-модели у зашифрованного чекпоинта не сработает — конфиг будет не найден.

2. `ModelConfig.from_server_args`: при `is_draft_model=True` в качестве `override_config_file` берется именно это поле, и дальше оно проходит тот же путь, что у целевой модели — `kwargs["_configuration_file"]` → `get_config` → `AutoConfig.from_pretrained` → `cached_file(model_path, filename)`.

Ограничения те же, что у целевой половины: это **имя файла**, резолвимое относительно пути draft-модели, и оно теряется на `mistral`-парсере (`MistralModelConfigParser.parse` начинается с `del kwargs`) — что особенно вероятно для draft-моделей, потому что эвристика `is_mistral_model` специально распознает связку `eagle` + `mistral` в имени пути.

Отдельная деталь: при `--context-length`, превышающем выведенную длину, для draft-модели `_derive_context_length` дополнительно переписывает `max_position_embeddings` и логирует «Overriding the draft model's max_position_embeddings to N» — но это поведение самой draft-ветки, а не этого аргумента.

## Значения и формат

- Строка; пробелы по краям срезаются.
- Пустая строка эквивалентна незаданному аргументу.
- Содержимое — обычный HF-конфиг draft-модели.
- Существование файла аргумент не проверяет; ошибка приходит из transformers.

## Когда использовать

- Только когда draft-модель — зашифрованный чекпоинт с отдельно расшифрованным конфигом.
- Задавайте одновременно с `--decrypted-config-file`, если зашифрованы обе модели: одно значение на другую не распространяется.
- Не используйте для правки отдельных полей draft-конфига: `--json-model-override-args` применяется к обеим моделям и не требует копии всего файла.

## Влияние на производительность и память

Чтение одного JSON на старте. Прямого влияния на VRAM, RAM и скорость нет. Косвенное — через конфигурацию draft-модели: число слоев draft'а входит в масштабирование `cell_size` KV-пула для EAGLE/DFLASH-семейств, то есть неверный конфиг здесь искажает расчет памяти.

## Взаимодействие с другими аргументами

- `--decrypted-config-file`: парная половина для целевой модели; выбирается по `is_draft_model`.
- `--speculative-draft-model-path`: путь, относительно которого резолвится имя файла.
- `--speculative-algorithm`: резолв алиаса читает draft-конфиг и потому зависит от этого аргумента.
- `--model-config-parser`: при `mistral` значение игнорируется; для draft-моделей с `eagle`+`mistral` в имени это состояние выбирается автоматически.
- `--speculative-draft-load-format`: отдельный слой — формат весов draft-модели.

## Типовые проблемы и диагностика

- `OSError: <draft path> does not appear to have a file named <значение>` — файла нет рядом с draft-моделью либо значение передано как абсолютный путь для удаленного repo ID.
- Спекулятивный алгоритм не определился по draft-модели — проверьте, что аргумент задан: резолв алиаса читает конфиг тем же способом.
- Значение задано, эффекта нет — сработал `mistral`-парсер по имени пути draft-модели; задайте `--model-config-parser hf` явно.
- Значение, как его принял движок, — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/encrypted-target --decrypted-config-file decrypted_config.json --speculative-algorithm EAGLE --speculative-draft-model-path /models/encrypted-draft --decrypted-draft-config-file decrypted_config.json
```

```bash
python -m sglang.launch_server --model-path /models/target --speculative-algorithm EAGLE --speculative-draft-model-path /models/encrypted-draft --decrypted-draft-config-file draft_decrypted.json --model-config-parser hf
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
