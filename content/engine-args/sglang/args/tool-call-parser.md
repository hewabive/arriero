---
schema: 1
engine: sglang
primaryName: "--tool-call-parser"
title: "--tool-call-parser"
summary: Выбирает детектор, который превращает нативную разметку вызова функции в поле `tool_calls` OpenAI-ответа. Список значений собирается из реестра детекторов при построении парсера аргументов; неверный выбор не роняет сервер, а молча оставляет разметку внутри `content`.
group: null
related:
  - --reasoning-parser
  - --chat-template
  - --tool-server
  - --grammar-backend
  - --default-chat-template-kwargs
  - --served-model-name
---

# --tool-call-parser

## Кратко

Модель печатает вызов инструмента своей нативной разметкой — у одних это `<tool_call>{…}</tool_call>`, у других `<|tool▁calls▁begin|>`, у третьих питонический вызов. `--tool-call-parser` включает детектор этого формата: он вырезает разметку из текста, собирает `tool_calls` и меняет `finish_reason` на `tool_calls`. Без аргумента сервер вернет разметку как обычный текст ответа, а массив `tool_calls` останется пустым — формально успешный ответ, который клиент не сможет исполнить.

## Оригинальная справка

```text
Specify the parser for handling tool-call interactions. Use 'auto' to detect from chat template. Options include: {tool_call_parser_choices}.
```

Фигурные скобки — часть f-строки в исходнике; в реальном `--help` там перечислены ключи реестра. Declaration extract читает объявление, а не подставленное значение.

## Паспорт аргумента

- Флаги: `--tool-call-parser`
- Группа: `null` — поле `ServerArgs.tool_call_parser` объявлено без `Arg(...)`, поэтому авто-регистрация его пропускает; флаг заводится литеральным `parser.add_argument` в `add_cli_args` (случай «динамические choices»)
- Тип значения: str
- Допустимые значения: в extract `choices: null`, но argparse ограничивает список — `["auto"] + list(FunctionCallParser.ToolCallParserEnum.keys())`. Реестр (`sglang/python/sglang/srt/function_call/function_call_parser.py`) собирается в момент вызова `add_cli_args` и зависит от версии пакета. Список своей сборки: `python -m sglang.launch_server --help | grep -A4 -- --tool-call-parser` либо `python -c "from sglang.srt.function_call.function_call_parser import FunctionCallParser as F; print(sorted(F.ToolCallParserEnum))"`
- Значение по умолчанию: `ServerArgs.tool_call_parser`, то есть `None` — разбор вызовов выключен
- Эффективное значение: при `auto` подменяется определенным по chat template значением либо `None`. Кроме того, `_handle_deprecated_args` переименовывает два устаревших ключа: `qwen25` → `qwen`, `glm45` → `glm`, с предупреждением в логе
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_deprecated_args` (переименование устаревших ключей) → `resolve_auto_parsers` до запуска процессов → `OpenAIServingChat.__init__` → разбор каждого ответа

## Что меняет в движке

### Резолюция `auto`

Та же машинерия, что у `--reasoning-parser`: `resolve_auto_parsers` (`sglang/python/sglang/srt/parser/template_detection.py`) читает chat template токенизатора либо явный Jinja-шаблон из `--chat-template` и сопоставляет его с `TOOL_CALL_PARSER_RULES`; при неудаче пробует определить по архитектуре модели. Результат печатается:

```text
Auto-detected --tool-call-parser as 'qwen' from chat template
```

```text
--tool-call-parser=auto specified but could not detect tool-call parser from chat template. Disabling tool-call parser.
```

Второй случай — не ошибка старта: разбор вызовов просто выключается.

### Разбор ответа

`_process_tool_calls` (`sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`) строит `FunctionCallParser(tools, <значение>, tokenizer=…)`. Дальше важен один нюанс, объясняющий типовой симптом:

```python
if should_try_parser and parser.has_tool_call(text):
    text, call_info_list = parser.parse_non_stream(text)
    ...
```

`has_tool_call` — это дешевая проверка на присутствие маркера конкретного формата. Если выбран детектор от другой модели, проверка вернет `False`, и функция дойдет до финального `return ToolCallProcessingResult(None, text, finish_reason)`: **вызов останется сырым текстом в `content`, `tool_calls` будет `null`, а `finish_reason` останется `stop`**. Ни ошибки, ни предупреждения в этом пути нет — только неверный ответ.

Если маркер найден, но разбор упал, в лог уходит `Tool call parsing error: …`, а ответ возвращается тем же способом — текстом.

Для `tool_choice: "required"` и именованного выбора инструмента путь другой: парсер используется только если детектор поддерживает structural tag или умеет разбирать required нативно; иначе ответ читается как JSON-массив, наложенный грамматикой.

### Устаревшие значения

`_handle_deprecated_args` печатает:

```text
The tool_call_parser 'qwen25' is deprecated. Please use 'qwen' instead.
```

и подменяет значение. Ключи `qwen25` и `glm45` в реестре пока присутствуют (указывают на те же классы), но использовать их не нужно.

## Значения и формат

- Одно значение из реестра либо `auto`. Опечатка отвергается argparse'ом: `error: argument --tool-call-parser: invalid choice: …`.
- Не задавать — значит выключить разбор.
- Ключи реестра называют **формат разметки**, а не модель: один и тот же детектор обслуживает несколько семейств (`glm45` и `glm` — один класс, `step3p5` использует детектор `qwen3_coder`). Выбирать надо по тому, что реально печатает модель.
- Значение действует на весь сервер; переопределить его на уровне запроса нельзя.

## Когда использовать

- Любой сценарий с function calling через OpenAI-совместимый чат: без аргумента `tool_calls` не появится.
- Задавать явно, когда chat template подменен своим файлом или модель дообучена: авто-детекция смотрит именно на шаблон.
- Не выбирать «похожее» значение наугад — молчаливая деградация до текста хуже отказа. Проще один раз посмотреть сырой ответ модели на запрос с инструментами и сопоставить маркер с детектором.
- В arriero это критично для Claude Code через Anthropic-мост: мост (`docs/ANTHROPIC_OPENAI_BRIDGE.md`) переводит `messages` в OpenAI chat completions и ждет структурного `tool_calls` в ответе. Не заданный или неверный парсер выглядит на стороне клиента как «модель говорит про инструмент, но не вызывает его».

## Влияние на производительность и память

На VRAM, KV-пул и планировщик не влияет. При `auto` старт удлиняется на загрузку токенизатора для чтения chat template. На горячем пути — построчный разбор в процессе токенизатор-менеджера; в потоковом режиме детектор вызывается на каждый чанк и может задерживать выдачу текста, пока не станет ясно, начинается ли разметка вызова.

## Взаимодействие с другими аргументами

- `--reasoning-parser`: независимая ручка с общим механизмом `auto`. В ответе сначала отделяется рассуждение, потом разбираются вызовы, поэтому неверный reasoning-парсер способен «съесть» текст с разметкой вызова до того, как до нее дойдет tool-парсер.
- `--chat-template`: источник авто-детекции; нечитаемый как Jinja шаблон отключает ее с предупреждением.
- `--tool-server`: отдельная возможность (MCP-серверы инструментов), не заменяет разбор ответа модели.
- `--grammar-backend`: используется на путях `tool_choice: required`/именованного инструмента, где ответ ограничивается грамматикой, а не разбирается детектором.
- `--default-chat-template-kwargs`: некоторые шаблоны меняют формат вызова в зависимости от переданных kwargs.

## Типовые проблемы и диагностика

- Ответ содержит `<tool_call>…` текстом, `tool_calls` пустой, `finish_reason: "stop"` — парсер не задан либо задан детектор другого формата. Это самый частый симптом и единственный, который не пишет ничего в лог.
- `Tool call parsing error: …` в логе — формат опознан, но разбор упал (обычно битый JSON в аргументах). Ответ вернулся текстом.
- `The tool_call_parser 'qwen25' is deprecated. Please use 'qwen' instead.` — устаревшее значение, замените.
- `--tool-call-parser=auto` ничего не включил — ищите `could not detect tool-call parser from chat template` и задайте значение явно.
- `error: argument --tool-call-parser: invalid choice: …` — значение отсутствует в реестре установленной версии; сверьтесь с `--help` своей сборки (`docs/CASE_PHANTOM_HELP_ARGS.md`).
- Чем подтвердить: дамп `server_args=` при старте, `GET /server_info` с уже разрешенным значением, и контрольный запрос с одним простым инструментом.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tool-call-parser qwen
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tool-call-parser auto --reasoning-parser auto
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/function_call/function_call_parser.py`
- `sglang/python/sglang/srt/parser/template_detection.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/docs/docs/advanced_features/tool_parser.mdx`
- arriero: `docs/ANTHROPIC_OPENAI_BRIDGE.md`, `docs/CASE_PHANTOM_HELP_ARGS.md`
