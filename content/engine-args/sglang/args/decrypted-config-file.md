---
schema: 1
engine: sglang
primaryName: "--decrypted-config-file"
title: "--decrypted-config-file"
summary: Имя файла конфигурации, который читается вместо `config.json`. Часть узкой схемы работы с зашифрованными чекпоинтами: сам SGLang ничего не расшифровывает, он лишь подставляет `_configuration_file` в вызов transformers.
group: model
related:
  - --decrypted-draft-config-file
  - --model-path
  - --model-config-parser
  - --json-model-override-args
  - --trust-remote-code
---

# --decrypted-config-file

## Кратко

`--decrypted-config-file` — это не «файл с ключом» и не расшифровка. Значение уходит в `AutoConfig.from_pretrained(..., _configuration_file=<значение>)`, то есть указывает transformers, какой файл читать вместо `config.json`. Аргумент существует для сценария, где чекпоинт зашифрован целиком, а конфиг заранее расшифрован во внешний файл. Никакой криптографии в SGLang по этому пути нет; расшифровка весов — отдельный слой (`LoadConfig.decryption_key_file`), у которого на текущем commit'е **нет** соответствующего CLI-аргумента.

## Оригинальная справка

```text
The path of the decrypted config file.
```

## Паспорт аргумента

- Флаги: `--decrypted-config-file`
- Группа: `model`
- Тип значения: строка
- Допустимые значения: не ограничены; смысл имеет имя файла, который transformers сможет найти относительно `--model-path`
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; пустая строка и строка из пробелов эквивалентны отсутствию (проверка `if override_config_file and override_config_file.strip()`)
- Где объявлен: `ServerArgs.decrypted_config_file`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, узкая интеграция со схемой шифрованных чекпоинтов
- Этап применения: построение `ModelConfig` — чтение конфигурации модели

## Что меняет в движке

`ModelConfig.from_server_args` выбирает источник:

```python
override_config_file = (
    server_args.decrypted_draft_config_file if is_draft_model else server_args.decrypted_config_file
)
```

и в `ModelConfig.__init__`:

```python
kwargs = {}
if override_config_file and override_config_file.strip():
    kwargs["_configuration_file"] = override_config_file.strip()
self.hf_config = copy.deepcopy(get_config(self.model_path, ..., **kwargs))
```

Дальше `_configuration_file` доходит до `PretrainedConfig._get_config_dict`, где он заменяет константу `CONFIG_NAME` и передается в `cached_file(path_or_repo_id, filename, …)`. Для локального каталога это `os.path.join(model_path, filename)`.

Отсюда два неочевидных ограничения:

- **Это имя файла, а не произвольный путь.** Абсолютный путь сработает для локального `--model-path` только потому, что `os.path.join` отбрасывает левую часть; для repo ID такое значение приведет к попытке скачать файл с таким именем из репозитория.
- **Работает только на `hf`-парсере.** `MistralModelConfigParser.parse` начинается с `del kwargs`, поэтому при `--model-config-parser mistral` (в том числе выбранном автоматически по имени модели) значение просто теряется.

## Значения и формат

- Строка. Ведущие и хвостовые пробелы срезаются (`strip()`).
- Пустая строка эквивалентна незаданному аргументу.
- Формат самого файла — обычный HF `config.json`; ничего специфического SGLang от него не требует.
- Аргумент не проверяет существование файла: ошибка приходит от transformers (`OSError: … does not appear to have a file named …`).

## Когда использовать

- Только в развертываниях с зашифрованными чекпоинтами, где расшифрованный конфиг кладется рядом отдельным файлом.
- Изредка — как способ подсунуть альтернативный конфиг, не трогая `config.json` в каталоге модели. Для точечных правок полей это хуже, чем `--json-model-override-args`: тот применяется поверх штатного конфига и не требует дублировать весь файл.
- Не используйте на моделях, идущих через `mistral`-парсер: значение будет проигнорировано молча.

## Влияние на производительность и память

Чтение одного JSON-файла на старте. На VRAM, RAM, время старта и пропускную способность не влияет. Косвенно влияет на всё через содержимое конфига — число слоев, голов, `max_position_embeddings`.

## Взаимодействие с другими аргументами

- `--decrypted-draft-config-file`: то же самое для draft-модели спекулятивного декодирования; выбор между ними делается по признаку `is_draft_model`.
- `--model-config-parser`: при `mistral` аргумент не действует.
- `--model-path`: имя резолвится относительно него.
- `--json-model-override-args`: применяется **после** чтения конфига, то есть поверх содержимого указанного файла.
- `--trust-remote-code`: если конфиг ссылается на собственный класс через `auto_map`, требование остается тем же.

## Типовые проблемы и диагностика

- `OSError: /models/x does not appear to have a file named decrypted_config.json` — файла нет рядом с моделью либо путь передан не как имя файла.
- Значение задано, а эффекта нет — почти наверняка сработал `mistral`-парсер. Проверяется явным `--model-config-parser hf`.
- Ошибки чтения зашифрованных **весов** этот аргумент не лечит: он про конфиг. Слой расшифровки весов (`decryption_key_file`, `decrypt_max_concurrency`) объявлен в `LoadConfig`, но CLI-аргументов для него в extract'е этого commit'а нет — значит, задать его через `sglang.launch_server` нельзя.
- Значение, как его принял движок, — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/encrypted-qwen3 --decrypted-config-file decrypted_config.json --model-config-parser hf
```

```bash
python -m sglang.launch_server --model-path /models/encrypted-qwen3 --decrypted-config-file decrypted_config.json --json-model-override-args '{"num_hidden_layers": 32}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
