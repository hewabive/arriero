---
schema: 1
engine: sglang
primaryName: "--model-config-parser"
title: "--model-config-parser"
summary: Чем читать конфигурацию модели: `hf` (AutoConfig над config.json), `mistral` (params.json нативного формата) или зарегистрированный плагином парсер. `auto` выбирает mistral по эвристике имени модели.
group: model
related:
  - --model-path
  - --trust-remote-code
  - --json-model-override-args
  - --load-format
  - --revision
  - --decrypted-config-file
---

# --model-config-parser

## Кратко

Аргумент выбирает реализацию `ModelConfigParserBase`, через которую читается конфигурация модели. Встроенных парсеров два: `hf` (`AutoConfig.from_pretrained` над `config.json` плюс набор пост-правок для отдельных архитектур) и `mistral` (`params.json` нативного формата Mistral). `auto` выбирает `mistral`, только если сработала **эвристика по имени пути**, а не по содержимому каталога — это единственная неочевидная часть аргумента. GGUF-вход всегда обрабатывается парсером `hf`.

## Оригинальная справка

```text
Which model-config parser to use. "auto" picks "mistral" via the is_mistral_model name heuristic, else "hf" (AutoConfig over config.json). Plugins can register additional parsers via @register_model_config_parser.
```

## Паспорт аргумента

- Флаги: `--model-config-parser`
- Группа: `model`
- Тип значения: строка
- Допустимые значения: `choices` нет — список собирается в runtime из реестра `_MODEL_CONFIG_PARSER_REGISTRY` (`sglang/python/sglang/srt/configs/model_config_parser_registry.py`). В самом checkout'е зарегистрированы `hf` и `mistral` (декоратор `@register_model_config_parser` в `sglang/python/sglang/srt/utils/hf_transformers/config.py`); плагины могут добавить свои. Посмотреть фактический список на своей сборке проще всего по сообщению об ошибке — при неизвестном имени движок печатает `Unknown model-config parser 'x'. Registered: [...]`
- Значение по умолчанию: `auto` (не имя парсера, а инструкция «выбрать»)
- Эффективное значение: `get_config()` резолвит `auto` в `mistral`, если `is_mistral_model(path)` вернул True, иначе в `hf`; для GGUF-входа значение принудительно становится `hf`
- Где объявлен: `ServerArgs.model_config_parser`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение `ModelConfig` — самое начало, до любых решений о памяти и backend'ах

## Что меняет в движке

`get_config()` (`sglang/python/sglang/srt/utils/hf_transformers/config.py`) делает следующее:

1. Если путь — GGUF-файл, то при `model_config_parser` не из `("auto", "hf")` бросается `ValueError: model_config_parser=… is incompatible with GGUF inputs; only 'hf' (or 'auto') is supported.` Далее путь переписывается на каталог-родитель, а парсер жестко ставится в `hf` (эвристика имени иначе сработала бы по неверной строке).
2. Разрешаются runai-URI и connector-URL (для последних файлы предварительно скачиваются).
3. При `auto` вызывается `is_mistral_model(model)` — она смотрит **строку пути**: `mistral-large-3`, `mistral-small-4`, `leanstral`, а также сочетание `eagle` + `mistral` для draft-моделей. Совпало — `mistral`, иначе — `hf`.
4. Выбранный парсер строит конфиг, после чего сверху накладываются `--json-model-override-args`.

`HfModelConfigParser` — это не просто `AutoConfig`: он пробует LongCat-конфиг, чинит Phi-4-MM, подменяет `model_type` для LongCat и DeepSeek-OCR, переносит поля text-конфига на верхний уровень. `MistralModelConfigParser` игнорирует все дополнительные kwargs (`del kwargs`) и вызывает `load_mistral_config`.

Последнее важно: **`--decrypted-config-file` передается именно через kwargs**, поэтому на пути `mistral` он не действует.

## Значения и формат

- `auto` — поведение по умолчанию, описано выше.
- `hf` — принудительно `AutoConfig`; нужен, когда каталог назван так, что эвристика ложно срабатывает на mistral.
- `mistral` — принудительно нативный парсер Mistral; нужен для чекпоинтов с `params.json` и `consolidated*.safetensors`, чьё имя не совпало с эвристикой.
- Неизвестное имя не отсекается argparse (нет `choices`), а падает при построении конфига: `ValueError: Unknown model-config parser …`.
- Значение регистрозависимо: сравнение идет со строками-ключами реестра.

## Когда использовать

- Практически никогда — `auto` покрывает оба встроенных случая.
- Задайте `mistral`, если чекпоинт нативного формата Mistral лежит в каталоге с произвольным именем и `auto` пошел по `hf`-пути (симптом — ошибка чтения `config.json`, которого в таком каталоге нет).
- Задайте `hf`, если каталог случайно назван `…mistral-large-3…`, а внутри обычный HF-чекпоинт.
- Задайте имя плагина, если ваша сборка ставит внешний парсер; проверьте, что он действительно зарегистрирован — реестр наполняется импортом модуля плагина.

## Влияние на производительность и память

На память и скорость не влияет: аргумент выбирает способ прочитать несколько килобайт JSON на старте. Косвенное влияние — через то, какие поля окажутся в конфиге (число слоев, голов, `max_position_embeddings`), но при корректном парсере результат совпадает.

## Взаимодействие с другими аргументами

- `--model-path`: значение эвристики `auto` считается по этой строке; для GGUF/`runai`/connector путь предварительно переписывается.
- `--load-format`: отдельный, но связанный автодетект — `_handle_load_format` независимо ставит `load_format=mistral` по составу каталога (`consolidated*.safetensors` без `model*.safetensors`). Формат весов и парсер конфига определяются **разными** проверками, и они могут разойтись.
- `--decrypted-config-file` / `--decrypted-draft-config-file`: работают только через kwargs `hf`-парсера.
- `--json-model-override-args`: применяется поверх результата парсера.
- `--trust-remote-code`: передается в парсер; для `mistral` он тоже пробрасывается в `load_mistral_config`.

## Типовые проблемы и диагностика

- `ValueError: Unknown model-config parser 'x'. Registered: ['hf', 'mistral']` — опечатка либо плагин не импортирован.
- `ValueError: model_config_parser='mistral' is incompatible with GGUF inputs; only 'hf' (or 'auto') is supported.` — GGUF-путь.
- `OSError: … config.json` на нативном Mistral-чекпоинте — сработал `hf`-парсер; задайте `--model-config-parser mistral`.
- `--decrypted-config-file` «не действует» — проверьте, не ушел ли выбор в `mistral`: этот парсер удаляет kwargs.
- Значение, как его принял движок, — в дампе `server_args=`; какой парсер выбрался фактически, отдельной строкой не логируется, поэтому при сомнениях задавайте парсер явно.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/mistral-native-ckpt --model-config-parser mistral --load-format mistral
```

```bash
python -m sglang.launch_server --model-path /models/my-mistral-large-3-finetune-hf --model-config-parser hf
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config_parser_registry.py`
- `sglang/python/sglang/srt/utils/hf_transformers/config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/mistral_utils.py`
- `sglang/python/sglang/srt/configs/model_config.py`
