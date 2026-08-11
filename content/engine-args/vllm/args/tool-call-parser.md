---
schema: 1
engine: vllm
primaryName: "--tool-call-parser"
title: "--tool-call-parser"
summary: Имя парсера, который вытаскивает вызовы инструментов из сгенерированного текста. Список имен реестровый и меняется от релиза к релизу; несовпадение с моделью выглядит как «модель не вызывает инструменты».
group: Frontend
related:
  - --enable-auto-tool-choice
  - --tool-parser-plugin
  - --chat-template
  - --reasoning-parser
  - --exclude-tools-when-tool-choice-none
  - --tokenizer-mode
---

# --tool-call-parser

## Кратко

Модель не возвращает `tool_calls` — она генерирует текст в своем формате (`<tool_call>{...}</tool_call>`, питоноподобный вызов, JSON после спецтокена). Парсер переводит этот текст в поле `tool_calls` OpenAI-ответа.

Парсер привязан к семейству модели, а не к задаче. Неправильное имя не даст ни ошибки, ни предупреждения в рантайме: `tool_calls` останется пустым, а разметка вызова уедет клиенту в `content`.

## Оригинальная справка

```text
Select the tool call parser depending on the model that you're using.
This is used to parse the model-generated tool call into OpenAI API format.
Required for `--enable-auto-tool-choice`. You can choose any option from
the built-in parsers or register a plugin via `--tool-parser-plugin`.
```

## Паспорт аргумента

- Флаги: `--tool-call-parser`
- Группа argparse: `Frontend`
- Тип значения: str (имя зарегистрированного парсера)
- Допустимые значения: `choices` в extract — `null`, потому что список **собирается в runtime** из реестра `ToolParserManager` (`vllm/tool_parsers/`), плюс имена, добавленные через `--tool-parser-plugin`. Актуальный для вашей сборки список печатает `vllm serve --help` в metavar этого аргумента (`{...} or name registered in --tool-parser-plugin`) и текст ошибки при неверном имени
- Значение по умолчанию: `None`
- Эффективное значение: при выключенном `--enable-auto-tool-choice` значение **игнорируется** — `ParserManager.get_tool_parser` возвращает `None`, не заглядывая в реестр
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.tool_call_parser`
- Этап применения: разбор CLI (metavar) → старт сервера (валидация имени) → инициализация состояния (класс парсера) → HTTP-слой, разбор каждого ответа

## Что меняет в движке

Реестр устроен лениво. `vllm/tool_parsers/__init__.py` содержит таблицу `_TOOL_PARSERS_TO_REGISTER` вида «имя → (модуль, класс)» и при импорте пакета вызывает `register_lazy_module` для каждой записи: имя становится известным, но модуль не импортируется. `ToolParserManager.get_tool_parser(name)` импортирует нужный модуль при первом обращении и кэширует класс. Поэтому `list_registered()` (то, что видно в `--help`) отражает и лениво объявленные, и зарегистрированные плагином имена.

Валидация имени происходит в `validate_api_server_args` (`vllm/entrypoints/openai/api_server.py`) **только при включенном** `--enable-auto-tool-choice`:

```text
KeyError: invalid tool call parser: <имя> (chose from { ... })
```

Дальше `ParserManager.get_parser` собирает класс `DelegatingParser` из reasoning- и tool-парсеров; он живет в `OnlineRenderer.parser` и в `OpenAIServingChat.parser_cls`. На запросе парсер делает две вещи:

- `adjust_request` — правит запрос до генерации (например, `Hermes2ProToolParser` выставляет `skip_special_tokens=False`, когда есть `tools` и `tool_choice != "none"`; парсеры Mistral могут навесить грамматику);
- `extract_tool_calls` / `extract_tool_calls_streaming` — разбирают вывод.

Если разметка не найдена, парсер возвращает `ExtractedToolCallInformation(tools_called=False, tool_calls=[], content=model_output)` — то есть весь сгенерированный текст, включая неразобранный вызов, уходит в `content`, а `finish_reason` остается `stop`.

## Значения и формат

- Одно имя из реестра, например `hermes`, `mistral`, `pythonic`, `llama3_json`. Имена соответствуют семействам моделей, а не форматам «в общем виде».
- Перечень имен в документ намеренно не переписан: он реестровый и меняется от релиза к релизу. Смотрите его на своей сборке:

  ```bash
  vllm serve --help | grep -A 3 -- --tool-call-parser
  ```

  либо запустите с заведомо неверным именем и прочитайте список из текста `KeyError`.
- Имя из плагина указывается так же, как встроенное; регистрация — через `--tool-parser-plugin`.
- Специальных значений нет. `None` (не задано) — вызовы инструментов не разбираются.

## Когда использовать

- Всегда вместе с `--enable-auto-tool-choice`, если инстанс должен обслуживать function calling.
- Начинайте с имени, рекомендованного для вашего семейства в `vllm/docs/features/tool_calling.md` того же checkout'а: там перечислены пары «модель → флаги», включая нужный шаблон.
- Не подбирайте имя «по похожести»: `hermes` и `pythonic` разбирают принципиально разную разметку, и ошибка проявится только на реальном вызове.
- Не задавайте без `--enable-auto-tool-choice`: имя будет молча проигнорировано, и запросы с `tool_choice` получат 400 с сообщением про отсутствующий парсер.

## Влияние на производительность и память

VRAM не затрагивает. Стоимость — CPU в процессе API-сервера. Потоковый разбор дороже нестримингового: `extract_tool_calls_streaming` вызывается на каждый дельта-чанк и у части парсеров выполняет разбор частичного JSON. При большом числе одновременных стримов это видно как рост загрузки процесса API-сервера, а не движка.

Через `adjust_request` парсер может изменить и генерацию: отключение `skip_special_tokens` возвращает спецтокены в детокенизированный текст, что меняет и длину ответа, и его содержимое для клиента.

## Взаимодействие с другими аргументами

- `--enable-auto-tool-choice`: без него значение не применяется; с ним — обязательная валидация имени.
- `--tool-parser-plugin`: расширяет реестр перед валидацией имени.
- `--chat-template`: шаблон должен генерировать ту же разметку, которую ждет парсер, и уметь рендерить `tool`-сообщения обратно в диалог.
- `--reasoning-parser`: работает в связке; общий `DelegatingParser` сначала отделяет рассуждения, затем вызовы.
- `--exclude-tools-when-tool-choice-none`: убирает описания инструментов из промпта, снижая шанс «галлюцинации» вызова при `tool_choice="none"`.
- `--tokenizer-mode`: в режиме `mistral` часть логики вызовов идет собственным путем, независимо от этого имени.

## Типовые проблемы и диагностика

- **Симптом:** `KeyError: invalid tool call parser: <имя> (chose from { ... })` при старте. **Причина:** имени нет в реестре этой версии. **Лечение:** взять имя из списка в тексте ошибки.
- **Симптом:** ответ приходит, `tool_calls` пуст, в `content` виден `<tool_call>{"name": ...}` или питоноподобный вызов. **Причина:** парсер не тот. **Проверка:** `finish_reason == "stop"` вместо `"tool_calls"`. **Лечение:** сменить имя парсера на соответствующее семейству модели.
- **Симптом:** в нестриминговом режиме вызовы разбираются, в стриминговом — рвутся на части. **Причина:** потоковый разбор у парсера работает по частичному JSON и чувствителен к тому, что модель прервала генерацию. **Проверка:** повторить тот же запрос без `stream`. **Лечение:** ограничить `max_tokens` так, чтобы вызов успевал закрыться, либо сменить парсер.
- **Симптом:** после включения парсера в ответе появились спецтокены. **Причина:** `adjust_request` выставил `skip_special_tokens=False`. **Лечение:** это ожидаемо для hermes-подобных парсеров; фильтровать на стороне клиента не нужно, разметка вызова уходит в `tool_calls`.
- **Симптом:** имя есть в extract/`--help`, но сборка его не знает. **Причина:** extract снят с исходников checkout'а, а установленный движок другой версии. **Проверка:** `vllm serve --help` в нужном окружении.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-auto-tool-choice --tool-call-parser hermes --chat-template /etc/vllm/qwen3-tools.jinja
```

```bash
vllm serve /models/Qwen3-4B --enable-auto-tool-choice --tool-call-parser my_parser --tool-parser-plugin /etc/vllm/my_tool_parser.py
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/tool_parsers/__init__.py`
- `vllm/vllm/tool_parsers/abstract_tool_parser.py`
- `vllm/vllm/tool_parsers/hermes_tool_parser.py`
- `vllm/vllm/parser/parser_manager.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/docs/features/tool_calling.md`
