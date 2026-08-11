---
schema: 1
engine: sglang
primaryName: "--tool-server"
title: "--tool-server"
summary: Подключает встроенные серверные инструменты (браузер, python) к `/v1/responses`: либо демонстрационный набор (`demo`), либо список MCP-серверов через запятую. К `/v1/chat/completions` и обычному tool calling отношения не имеет.
group: serving
related:
  - --tool-call-parser
  - --reasoning-parser
  - --enable-strict-thinking
  - --model-path
---

# --tool-server

## Кратко

Речь идет не про tool calling OpenAI-протокола (`tools` в теле запроса — их обслуживает `--tool-call-parser`), а про **серверные** инструменты в стиле OpenAI Responses API: `web_search`/`web_search_preview` и `code_interpreter`, которые выполняет сам сервер, а не клиент.

Механизм построен на формате Harmony и практически целиком завязан на gpt-oss: описания инструментов вставляются в системное сообщение только на harmony-пути, а сама сборка `OpenAIServingResponses` требует пакета `openai_harmony`. MCP-режим дополнительно требует пакет `mcp`.

## Оригинальная справка

```text
Either 'demo' or a comma-separated list of tool server urls to use for the model. If not specified, no tool server will be used.
```

## Паспорт аргумента

- Флаги: `--tool-server`
- Группа: `serving`
- Тип значения: строка — литерал `demo` либо список адресов через запятую
- Допустимые значения: `choices` нет. Разбор чисто литеральный: `"demo"` — особый случай, любая другая непустая строка трактуется как список MCP-адресов
- Значение по умолчанию: `null` — серверных инструментов нет
- Эффективное значение: `__post_init__` не переопределяет. Но при незаданном аргументе и установленной переменной окружения `EXA_API_KEY` вместо «нет инструментов» подключается `NativeToolServer` — то есть эффективное поведение отличается от объявленного дефолта
- Где объявлен: `ServerArgs.tool_server`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `lifespan` HTTP-сервера при старте (создание tool server и `OpenAIServingResponses`) → обработка запросов к `/v1/responses`

## Что меняет в движке

Развилка одна, в `sglang/python/sglang/srt/entrypoints/http_server.py`:

```python
tool_server = None
if server_args.tool_server == "demo":
    tool_server = DemoToolServer()
elif server_args.tool_server:
    tool_server = MCPToolServer()
    await tool_server.add_tool_server(server_args.tool_server)
elif envs.EXA_API_KEY.get():
    tool_server = NativeToolServer()
```

- **`demo`** — `DemoToolServer` (`sglang/python/sglang/srt/entrypoints/openai/tool_server.py`) собирает два инструмента: `browser` (через `HarmonyBrowserTool`, работает только при заданном `EXA_API_KEY`, иначе печатает `EXA_API_KEY is not set, browsing is disabled` и выключается) и `python` (`HarmonyPythonTool`).
- **список адресов** — `MCPToolServer.add_tool_server` режет строку по запятой и для каждого элемента формирует `http://{url}/sse`, подключается по MCP SSE, читает `list_tools()` и переводит схемы в формат Harmony (`trim_schema`). Имя пространства инструментов берется из `serverInfo.name` MCP-сервера; дубликат имени игнорируется с предупреждением `Tool %s already exists. Ignoring duplicate tool server %s`.
- **не задано, но есть `EXA_API_KEY`** — `NativeToolServer`.

Полученный объект передается в `OpenAIServingResponses`. Дальше:

- `supports_browsing` / `supports_code_interpreter` вычисляются как `tool_server.has_tool("browser")` и `has_tool("python")`;
- описания инструментов вставляются в системное сообщение только в harmony-ветке и только если клиент в запросе перечислил соответствующие типы (`web_search`, `web_search_preview`, `code_interpreter`);
- harmony-путь включается по `model_config.hf_config.model_type == "gpt_oss"`.

Конструирование `OpenAIServingResponses` обернуто в `try/except` с одной строкой WARNING: эндпоинт считается необязательным, и его падение (например из-за отсутствующего `openai_harmony`) не роняет сервер.

## Значения и формат

- `demo` — точное строковое совпадение, регистр значим.
- Список MCP: `host:port` **без схемы**, через запятую, без пробелов — код сам добавляет `http://` и суффикс `/sse`. Строка вида `http://127.0.0.1:8000` превратится в `http://http://127.0.0.1:8000/sse` и не подключится.
- Пустая строка эквивалентна «не задан» (проверка `elif server_args.tool_server:` falsy).
- Значения «отключить» нет; чтобы отключить, аргумент не задают — и следят, чтобы не был выставлен `EXA_API_KEY`.

## Когда использовать

- Обслуживаете gpt-oss через `/v1/responses` и хотите серверный web search / python.
- Есть свой MCP-сервер с инструментами, и вы хотите, чтобы модель видела их описания в системном промпте.
- **Не используйте** для обычного OpenAI tool calling: для него нужен `--tool-call-parser`, а `tools` приходят в теле запроса.
- **Не включайте** на инстансе, доступном не только с localhost, без осознанного решения: сервер начнет сам ходить в сеть (браузер) и исполнять код (`python`) от имени процесса модели. Это расширение поверхности атаки, а не только функция.
- **Бесполезно** для не-gpt-oss моделей: описания инструментов подставляются в системное сообщение только на harmony-пути.

## Влияние на производительность и память

- На VRAM, KV-пул и скорость forward влияния нет.
- Описания инструментов удлиняют системное сообщение — это дополнительные prefill-токены на каждый запрос, где инструменты запрошены.
- Исполнение инструмента — сетевой вызов или запуск кода вне модели; латентность ответа `/v1/responses` при этом определяется внешним сервисом, а не сервером.
- MCP-подключение выполняется один раз при старте, добавляя к нему время round-trip до каждого адреса; недоступный адрес превращается в исключение внутри `lifespan`.

## Взаимодействие с другими аргументами

- `--tool-call-parser`: независимый механизм для клиентских инструментов. Оба могут быть заданы одновременно и не конфликтуют.
- `--reasoning-parser` / `--enable-strict-thinking`: у gpt-oss тесно связаны с harmony-разметкой каналов; фильтрация thinking и tool-инструменты работают на разных уровнях.
- `--model-path`: определяет `model_type`, а значит и включение harmony-ветки.
- Переменная окружения `EXA_API_KEY` (`sglang/python/sglang/srt/environ.py`) — фактический переключатель браузерного инструмента и самостоятельный триггер `NativeToolServer`.

## Типовые проблемы и диагностика

- **`/v1/responses` вообще отсутствует** — конструктор упал; ищите одну WARNING-строку при старте (типовая причина — не установлен `openai_harmony` или не скачался harmony-словарь).
- **`ImportError` про `mcp`** — MCP-режим требует пакет `mcp`; в `tool_server.py` он импортируется опционально и ошибка всплывает при подключении.
- **Сервер не стартует, зависая на подключении к инструментам** — недоступный адрес в списке: `add_tool_server` вызывается прямо в `lifespan` до готовности приложения.
- `MCP tool server is not supported in background mode and streaming mode` — MCP-инструменты запрошены вместе с `stream: true` или `background: true`; используйте нестриминговый запрос.
- **`browser` не появился при `--tool-server demo`** — не задан `EXA_API_KEY`; в логе `EXA_API_KEY is not set, browsing is disabled`.
- **Инструменты подключены, но модель их не видит** — клиент не перечислил `web_search`/`code_interpreter` в `tools` запроса, либо модель не gpt-oss и harmony-ветка не активна.
- Подтверждение подключения MCP: строка `Tool <name> already exists…` (при дубликатах) и отсутствие исключений на старте; принятое значение — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/gpt-oss-20b --tool-server demo --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/gpt-oss-20b --tool-server 127.0.0.1:8000,127.0.0.1:8001 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/openai/tool_server.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_responses.py`
- `sglang/python/sglang/srt/entrypoints/tool.py`
- `sglang/python/sglang/srt/environ.py`
