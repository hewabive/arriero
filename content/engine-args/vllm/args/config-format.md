---
schema: 1
engine: vllm
primaryName: "--config-format"
title: "--config-format"
summary: Каким парсером читать конфиг модели — HF (`config.json`) или Mistral (`params.json`). Трогают, когда автоопределение выбрало не тот формат или репозиторий содержит оба файла.
group: ModelConfig
related:
  - --hf-config-path
  - --hf-overrides
  - --tokenizer-mode
  - --load-format
  - --revision
---

# --config-format

## Кратко

vLLM умеет читать два разных описания модели: обычный HF `config.json` и mistral-овский `params.json`. `--config-format` выбирает парсер. По умолчанию `auto` определяет формат по содержимому репозитория, и в подавляющем большинстве случаев угадывает верно.

Флаг нужен, когда репозиторий содержит оба файла и они расходятся, либо когда автоопределение падает на репозитории без узнаваемого конфига.

## Оригинальная справка

```text
The format of the model config to load:

- "auto" will try to load the config in hf format if available after trying
  to load in mistral format.
- "hf" will load the config in hf format.
- "mistral" will load the config in mistral format.
```

## Паспорт аргумента

- Флаги: `--config-format`
- Группа argparse: `ModelConfig`
- Тип значения: str
- Допустимые значения: `auto`, `hf`, `mistral` — но это **подсказка (metavar), а не `choices`**: поле объявлено как `str | ConfigFormat`, и `literal_to_kwargs` в такой union'е переключается с `choices` на `metavar`, поэтому argparse примет любую строку. Незнакомое имя падает позже, в `get_config_parser`, с «Unknown config format `X`.». Список реальных парсеров — реестровый: `_CONFIG_FORMAT_TO_CONFIG_PARSER` в `vllm/transformers_utils/config.py`, расширяется декоратором `register_config_parser`
- Значение по умолчанию: `auto`
- Эффективное значение: при `auto` заменяется на `hf` или `mistral` внутри `get_config()` по результату проб
- Где объявлен: `vllm/config/model.py:ModelConfig.config_format`
- Этап применения: `ModelConfig.__post_init__` → `get_config()`, самый ранний шаг сборки конфига; то же значение переиспользуется в `_get_and_verify_dtype` и `try_get_generation_config`

## Что меняет в движке

`get_config()` (`vllm/transformers_utils/config.py`) при `auto` выполняет пробы **в порядке mistral → hf**, вопреки формулировке справки:

1. `is_mistral_model_repo(...)` — в репозитории есть файлы по маске `consolidated*.safetensors` — **и** существует `params.json` (`MISTRAL_CONFIG_NAME`) ⇒ формат `mistral`;
2. иначе существует `config.json` (`HF_CONFIG_NAME`) ⇒ формат `hf`;
3. иначе `ValueError`: «Could not detect config format for no config file found. With config_format 'auto', ensure your model has either config.json (HF format) or params.json (Mistral format). Otherwise please specify your_custom_config_format in engine args for customized config parser.»

Дальше `get_config_parser(config_format)` возвращает объект парсера и вызывает его `parse(...)` с `trust_remote_code`, `revision`, `code_revision` и `hf_overrides`.

- **`HFConfigParser`**: `PretrainedConfig.get_config_dict` + `AutoConfig.from_pretrained`; тут же обрабатывается `hf_overrides` (включая специальный случай `model_type`), подключаются патчи rope и allowed layer types, а `model_type` из `_CONFIG_REGISTRY` подменяет класс конфига.
- **`MistralConfigParser`**: скачивает `params.json`, при отсутствии `max_position_embeddings` добирает его из HF-конфига, при отсутствии `dtype` определяет его по метаданным safetensors, затем адаптирует словарь в `PretrainedConfig` (`vllm/transformers_utils/configs/mistral.py:adapt_config_dict`).

Результат один и тот же по типу — `PretrainedConfig`, — но набор и происхождение полей разные, поэтому от выбора формата зависят и `max_model_len`, и определённый `dtype`, и найденная `quantization_config`.

## Значения и формат

- `auto` — проба mistral, затем hf. Дефолт, менять без причины не нужно.
- `hf` — читать `config.json` даже если рядом лежит `params.json`.
- `mistral` — читать `params.json`; для репозитория без него загрузка упадёт на скачивании файла.
- Любая другая строка принимается парсером аргументов, но требует зарегистрированного через `register_config_parser` плагина; иначе `ValueError: Unknown config format \`X\`.`.
- Проверить, что принимает именно ваша сборка: `vllm serve --help` в нужном окружении.

## Когда использовать

- Репозиторий Mistral, где `config.json` присутствует как «совместимая обёртка», но реальная истина в `params.json` (или наоборот) — и автоопределение выбрало не тот файл.
- Локальная копия модели, где вы удалили один из конфигов и `auto` теперь падает.
- Кастомный формат, поддержанный плагином в вашем окружении.
- **Не используйте** `--config-format mistral` как «включить mistral-режим целиком»: токенизатор выбирается отдельно (`--tokenizer-mode mistral`), а формат весов — `--load-format`. Три независимых переключателя.

## Влияние на производительность и память

Само чтение конфига — доли секунды на старте (плюс сетевой запрос к Hub, если модель не локальная). На VRAM, KV-cache и throughput флаг не влияет напрямую. Косвенно влияет сильно: из конфига берутся `max_position_embeddings`, число слоёв и голов, `dtype` и `quantization_config` — то есть всё, из чего считаются веса и KV-cache. Ошибочный формат даёт неверный `max_model_len` или неверную архитектуру, а не «чуть другую» производительность.

## Взаимодействие с другими аргументами

- `--hf-config-path`: задаёт, **откуда** читать конфиг; `--config-format` — **как** его читать. Применяются вместе.
- `--hf-overrides`: правки применяются уже к результату выбранного парсера; для `hf` они дополнительно участвуют в выборе класса конфига через `model_type`.
- `--tokenizer-mode`: отдельный переключатель на `mistral_common`; формат конфига его не задаёт.
- `--load-format`: формат весов, тоже независим.
- `--revision`, `--code-revision`: передаются в парсер и определяют, какая версия файлов читается.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Could not detect config format for no config file found...` **Причина:** в репозитории/каталоге нет ни `config.json`, ни `params.json` (частая причина — указан каталог с одними весами). **Лечение:** проверить путь; при конфиге в другом месте — `--hf-config-path`.
- **Симптом:** `ValueError: Unknown config format \`X\`.` **Причина:** имя формата принято парсером аргументов (там metavar, а не choices), но парсер не зарегистрирован. **Лечение:** одно из `auto`/`hf`/`mistral` либо установка плагина.
- **Симптом:** модель поднялась, но `max_model_len` не тот, что ожидался. **Причина:** `auto` выбрал mistral-путь, где `max_position_embeddings` добирается отдельным запросом. **Проверка:** строка `Using max model len N` в логе старта. **Лечение:** явный `--config-format hf` либо `--max-model-len`.
- **Симптом:** архитектура определилась неверно. **Проверка:** строка `Resolved architecture: <Arch>`. **Лечение:** `--config-format hf` вместе с `--hf-overrides '{"architectures": ["..."]}'`.
- **Подтверждение принятого значения:** прямой строки нет; ориентируйтесь на `Resolved architecture` и `Using max model len`.

## Примеры

```bash
vllm serve mistralai/Mistral-7B-Instruct-v0.3 --config-format mistral --tokenizer-mode mistral --load-format mistral
```

```bash
vllm serve /models/mixed-repo --config-format hf --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/transformers_utils/repo_utils.py`
- `vllm/vllm/engine/arg_utils.py`
