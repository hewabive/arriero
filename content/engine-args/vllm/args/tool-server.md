---
schema: 1
engine: vllm
primaryName: "--tool-server"
title: "--tool-server"
summary: Подключает внешние MCP-серверы инструментов (или встроенные demo-инструменты) к Responses API. Значение `demo` включает исполнение сгенерированного моделью Python-кода в Docker без сетевой изоляции.
group: Frontend
related:
  - --enable-auto-tool-choice
  - --tool-call-parser
  - --api-key
  - --host
---

# --tool-server

## Кратко

Аргумент относится только к `/v1/responses`: `tool_server` передается в `OpenAIServingResponses` и больше никуда. На `/v1/chat/completions` он не действует.

Значение `demo` — не тестовый режим, а включение реального исполнения кода: Python-инструмент из пакета `gpt-oss` запускает сгенерированный моделью код в Docker-контейнере, у которого по умолчанию нет сетевой изоляции.

## Оригинальная справка

```text
Comma-separated list of host:port pairs (IPv4, IPv6, or hostname).
Examples: 127.0.0.1:8000, [::1]:8000, localhost:1234. Or `demo` for
built-in demo tools (browser and Python code interpreter). WARNING:
The `demo` Python tool executes model-generated code in Docker without
network isolation by default. See the security guide for more
information.
```

## Паспорт аргумента

- Флаги: `--tool-server`
- Группа argparse: `Frontend`
- Тип значения: str — список `host:port` через запятую либо литерал `demo`
- Допустимые значения: `choices` нет; разбор — `server_url.split(",")`, каждый элемент превращается в `http://<элемент>/sse`
- Значение по умолчанию: `None` — ни один сервер инструментов не подключается
- Эффективное значение: не переопределяется; при `demo` инструмент включается только если выполнены его собственные условия (см. ниже)
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.tool_server`
- Этап применения: инициализация состояния генеративного роутера (`init_generate_state`), до создания serving-классов

## Что меняет в движке

`vllm/entrypoints/generate/api_router.py` строит объект `ToolServer` по значению:

- `demo` → `DemoToolServer.init_and_validate()`. Регистрируются два инструмента из `vllm/entrypoints/mcp/tool.py`: `browser` (поиск через Exa, включается **только** при заданном `EXA_API_KEY`) и `python` (исполнение кода через `gpt_oss.tools.python_docker`, требует установленного пакета `gpt_oss` версии не ниже 0.0.7). Недоступный инструмент не включается, а пишет предупреждение в лог.
- непустая строка → `MCPToolServer.add_tool_server(value)`. Для каждого `host:port` собирается URL `http://<host:port>/sse`, выполняется MCP-инициализация и `list_tools`, описания приводятся к формату Harmony. Требуется установленный пакет `mcp`, иначе конструктор бросает `ImportError` с подсказкой `pip install mcp`.
- `None` → `tool_server = None`.

Получившийся объект попадает **только** в `OpenAIServingResponses`. Там он определяет, какие серверные инструменты (`browser`, `python`, `container`) доступны запросу, и открывает сессию инструмента на время обработки. Дополнительный шлюз — переменная окружения `VLLM_GPT_OSS_SYSTEM_TOOL_MCP_LABELS`: если она пуста, встроенные инструменты, запрошенные через тип `mcp`, не включаются вовсе (`vllm/docs/usage/security.md`).

## Значения и формат

- Один адрес: `--tool-server 127.0.0.1:8000`.
- Несколько через запятую без пробелов: `--tool-server 127.0.0.1:8000,127.0.0.1:8001`.
- IPv6 в скобках: `--tool-server [::1]:8000`.
- Схема не указывается — она всегда `http`, а путь всегда `/sse`. Подключиться к MCP-серверу по HTTPS этим аргументом нельзя.
- Литерал `demo` не комбинируется с адресами: сравнение `args.tool_server == "demo"` строгое, строка `demo,127.0.0.1:8000` уйдет в MCP-ветку и превратится в неверный URL.
- Имена инструментов при коллизии не объединяются: второй сервер с тем же именем игнорируется с предупреждением `Tool <name> already exists. Ignoring duplicate tool server <url>`.

## Когда использовать

- Есть собственный MCP-сервер инструментов и клиент, работающий через Responses API. Это единственный штатный сценарий.
- `demo` — только на изолированной машине для воспроизведения примеров gpt-oss, с осознанным пониманием, что модель получает исполнение кода и сетевой доступ контейнера к хосту и LAN.
- Не включайте `demo` на сервере, доступном не только с localhost: контейнер наследует сетевую конфигурацию Docker и может достучаться до внутренних сервисов и до сервиса метаданных облака (`169.254.169.254`); prompt injection превращается в SSRF.
- Не включайте, если клиенты ходят только в `/v1/chat/completions`: аргумент туда не доходит и ничего не даст.

## Влияние на производительность и память

На VRAM и KV-cache не влияет. На время старта влияет: MCP-ветка выполняет сетевые вызовы `initialize` и `list_tools` к каждому адресу до того, как сервер начнет слушать порт; недоступный адрес задерживает или срывает старт. Описания инструментов добавляются в промпт и расходуют контекст и KV-cache на каждый запрос. Исполнение инструментов — это работа на хосте (Docker-контейнер, сетевые запросы), она конкурирует с движком за CPU и RAM, но не за VRAM.

## Взаимодействие с другими аргументами

- `--enable-auto-tool-choice`, `--tool-call-parser`: относятся к разбору вызовов, объявленных клиентом в `tools`. Серверные инструменты из `--tool-server` — независимый механизм на другом эндпоинте.
- `--api-key`: единственная встроенная преграда между внешним клиентом и исполнением инструментов; при `demo` ее наличие обязательно, а лучше — недоступность порта извне.
- `--host`: держите сервер с включенными инструментами на `127.0.0.1`.

## Типовые проблемы и диагностика

- **Симптом:** `ImportError: mcp is not installed. Please run pip install mcp to use MCPToolServer.` **Причина:** задан адрес, но пакет `mcp` отсутствует в окружении. **Лечение:** установить пакет либо убрать аргумент.
- **Симптом:** при `demo` в логе `EXA_API_KEY is not set, browsing is disabled`. **Причина:** нет ключа Exa. **Лечение:** это ожидаемо; browser просто не регистрируется.
- **Симптом:** при `demo` в логе `gpt_oss is not installed properly (...), browsing is disabled`. **Причина:** пакет `gpt_oss` отсутствует или старше 0.0.7. **Лечение:** установить требуемую версию.
- **Симптом:** старт зависает или падает на инициализации MCP. **Причина:** адрес недоступен или не отвечает по `/sse`. **Проверка:** `curl http://<host:port>/sse`. **Лечение:** поднять сервер до старта vLLM.
- **Подтверждение принятого значения:** в логе `DemoToolServer initialized with tools: [...]` или `MCPToolServer initialized with tools: [...]`.
- **Симптом (arriero):** инстанс с `--tool-server demo` слушает не только loopback. **Причина:** `--host 0.0.0.0`. **Лечение:** ограничить хост и не публиковать такой инстанс через прокси.

## Примеры

```bash
vllm serve /models/gpt-oss-20b --tool-server 127.0.0.1:8000 --host 127.0.0.1
```

```bash
vllm serve /models/gpt-oss-20b --tool-server 127.0.0.1:8000,127.0.0.1:8001 --api-key local-only
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/mcp/tool_server.py`
- `vllm/vllm/entrypoints/mcp/tool.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/vllm/entrypoints/openai/responses/serving.py`
- `vllm/docs/usage/security.md`
