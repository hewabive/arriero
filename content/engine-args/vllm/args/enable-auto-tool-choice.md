---
schema: 1
engine: vllm
primaryName: "--enable-auto-tool-choice"
title: "--enable-auto-tool-choice"
summary: Включает разбор tool-call'ов, сгенерированных моделью самостоятельно. Без него `tool_choice` в запросе отвергается, а `--tool-call-parser` фактически не подключается.
group: Frontend
related:
  - --tool-call-parser
  - --tool-parser-plugin
  - --exclude-tools-when-tool-choice-none
  - --chat-template
  - --reasoning-parser
  - --structured-outputs-config
---

# --enable-auto-tool-choice

## Кратко

Флаг — выключатель всего слоя разбора вызовов инструментов. Он обязателен для `tool_choice="auto"`, но фактически нужен и для `"required"`, и для именованной функции: без него `ParserManager` не инстанцирует tool-парсер вообще.

Требует `--tool-call-parser`: без него процесс падает при разборе аргументов, до загрузки модели.

## Оригинальная справка

```text
Enable auto tool choice for supported models. Use `--tool-call-parser`
to specify which parser to use.
```

## Паспорт аргумента

- Флаги: `--enable-auto-tool-choice`, `--no-enable-auto-tool-choice`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но связано жесткой проверкой — `--enable-auto-tool-choice` без `--tool-call-parser` даёт `TypeError: Error: --enable-auto-tool-choice requires --tool-call-parser`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.enable_auto_tool_choice`
- Этап применения: разбор CLI (валидация пары) → инициализация состояния API-сервера (создание парсера) → HTTP-слой, каждый чат-запрос

## Что меняет в движке

1. **Валидация пары** в `validate_parsed_serve_args` и `validate_api_server_args`: при включенном флаге имя из `--tool-call-parser` обязано быть в `ToolParserManager.list_registered()`, иначе `KeyError` со списком известных имен.
2. **Создание парсера.** `ParserManager.get_tool_parser` (`vllm/parser/parser_manager.py`) начинается со строки `if not enable_auto_tools or tool_parser_name is None: return None`. То есть при выключенном флаге имя парсера просто игнорируется. Если при этом не задан и `--reasoning-parser`, `get_parser` возвращает `None`, и у `OnlineRenderer` вообще нет парсера.
3. **Проверка запроса.** `render_chat` (`vllm/renderers/online_renderer.py`) при отсутствующем tool-парсере (и не-Mistral токенизаторе, и не-Harmony модели) отвергает любой `tool_choice`, кроме `None` и `"none"`:
   - `tool_choice="auto"` и выключенный флаг → `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`;
   - `tool_choice="required"` или именованная функция → `tool_choice="required" requires --tool-call-parser to be set`. Сообщение вводит в заблуждение: парсер может быть задан, не хватает именно этого флага.
4. **Разбор ответа.** При включенном флаге текст генерации проходит через `ToolParser.extract_tool_calls` (потоковый вариант — `extract_tool_calls_streaming`), и найденные вызовы уходят в `choices[].message.tool_calls`, а `finish_reason` становится `tool_calls`.

Исключения: модели Harmony (`model_type == "gpt_oss"`) и Mistral-токенизаторы имеют собственный путь и не считаются «без парсера».

## Значения и формат

- Включение: `--enable-auto-tool-choice`. Выключение: `--no-enable-auto-tool-choice` (или ничего).
- «Не задан» = `false`, а не «решит движок».
- Значение осмысленно только в паре с `--tool-call-parser`; одиночный флаг — гарантированный отказ на старте.

## Когда использовать

- Любой сценарий, где модель сама решает, вызывать ли инструмент: агенты, function calling из OpenAI SDK, Claude Code через мост arriero.
- Нужен и для `tool_choice="required"`/именованной функции — вопреки названию флага.
- Не включайте на инстансе, который обслуживает только простой чат: парсер добавляет работу на каждый ответ и может «увидеть» вызов в обычном тексте, если модель случайно воспроизвела разметку.
- Не включайте без сверки шаблона: шаблон обязан рендерить сообщения роли `tool` и `assistant.tool_calls`, иначе многошаговый диалог развалится на втором ходе.

## Влияние на производительность и память

VRAM и KV-cache не затрагивает. Стоимость — CPU в процессе API-сервера: разбор выходного текста регулярными выражениями/JSON-парсером, а в потоковом режиме — на каждый дельта-чанк. Заметно при высокой конкуренции и длинных ответах.

Косвенный эффект на промпт: некоторые парсеры в `adjust_request` меняют параметры запроса — например `Hermes2ProToolParser` выставляет `skip_special_tokens=False`, когда в запросе есть `tools` и `tool_choice != "none"`. Это меняет детокенизацию и, соответственно, текст, который увидит клиент.

## Взаимодействие с другими аргументами

- `--tool-call-parser`: обязателен; имя парсера должно быть зарегистрировано.
- `--tool-parser-plugin`: позволяет использовать имя парсера из внешнего файла.
- `--exclude-tools-when-tool-choice-none`: определяет, попадают ли описания инструментов в промпт при `tool_choice="none"`.
- `--chat-template`: без tool-совместимого шаблона включенный флаг ничего не спасет.
- `--reasoning-parser`: комбинируется — `ParserManager.get_parser` собирает делегирующий парсер из обоих; при заданном reasoning-парсере объект парсера создается даже без этого флага, но `tool_parser_cls` в нем останется `None`.
- `--structured-outputs-config`: при `tool_choice="required"` и именованной функции ограничение вывода идет через structured outputs, а не через парсер.

## Типовые проблемы и диагностика

- **Симптом:** старт падает с `TypeError: Error: --enable-auto-tool-choice requires --tool-call-parser`. **Причина:** флаг без парсера. **Лечение:** добавить `--tool-call-parser <имя>`.
- **Симптом:** старт падает с `KeyError: invalid tool call parser: <имя> (chose from { ... })`. **Причина:** имя не зарегистрировано в этой сборке. **Лечение:** взять имя из выведенного списка либо зарегистрировать плагин.
- **Симптом:** 400 `tool_choice="required" requires --tool-call-parser to be set`, хотя парсер задан. **Причина:** не задан `--enable-auto-tool-choice`. **Лечение:** добавить флаг.
- **Симптом:** запросы проходят, `tool_calls` всегда пуст, а в `content` виден сырой текст вызова. **Причина:** парсер не соответствует разметке модели. **Проверка:** `finish_reason` равен `stop`, а не `tool_calls`. **Лечение:** сменить `--tool-call-parser`.
- **Подтверждение принятого значения:** при первом создании парсера в лог один раз уходит `"auto" tool choice has been enabled.`

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-auto-tool-choice --tool-call-parser hermes --chat-template /etc/vllm/qwen3-tools.jinja
```

```bash
vllm serve /models/Qwen3-4B --enable-auto-tool-choice --tool-call-parser hermes --exclude-tools-when-tool-choice-none
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/parser/parser_manager.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/tool_parsers/hermes_tool_parser.py`
- `vllm/docs/features/tool_calling.md`
