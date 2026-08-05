---
schema: 1
primaryName: "--mcp-servers-json"
title: "--mcp-servers-json"
summary: "Передаёт Cursor-совместимые определения локальных stdio MCP-серверов прямо в CLI или env вместо отдельного файла."
category: "Параметры llama-server"
valueType: "string"
valueHint: "JSON"
aliases:
  - "--mcp-servers-json"
allowedValues: []
env:
  - "LLAMA_ARG_MCP_SERVERS_JSON"
related:
  - "--mcp-servers-config"
  - "--tools"
  - "--api-key"
  - "--cors-origins"
---

# --mcp-servers-json

## Кратко

`--mcp-servers-json` принимает inline JSON того же формата `mcpServers`, что и `--mcp-servers-config`. Это удобно для ephemeral/container-конфигурации, но требует аккуратного quoting и может раскрыть содержимое через список процессов или deployment metadata.

## Оригинальная справка llama.cpp

```text
experimental: inline JSON with MCP server definitions (Cursor-compatible format) - do not enable in untrusted environments (default: none)
note: for security reasons, this will limit --cors-origins to localhost by default
```

## Паспорт аргумента

- Основное имя: `--mcp-servers-json`
- Значение: JSON-строка с объектом `mcpServers`
- Переменная окружения: `LLAMA_ARG_MCP_SERVERS_JSON`
- Поле в `common_params`: `mcp_servers_json`
- Значение по умолчанию: пусто
- Транспорт MCP: локальный stdio subprocess

## Что меняет в llama-server

Определения добавляются после записей из `--mcp-servers-config`. Имена должны быть уникальны: если inline JSON повторяет имя из файла, inline-запись пропускается. Успешно обнаруженные tools публикуются в `/tools` как `<server>_<tool>`; встроенные `--tools` можно включать независимо.

```json
{"mcpServers":{"echo":{"command":"python3","args":["/opt/mcp/echo.py"]}}}
```

Поддерживаются `command`, `args`, `cwd`, `env` и `timeout_ms`. `command` обязателен. Подробности жизненного цикла, warmup и диагностики приведены в странице `--mcp-servers-config`.

## Влияние на память и безопасность

Веса/KV/VRAM модели не меняются, но каждый MCP subprocess потребляет внешнюю host RAM и CPU, которые статический model estimator не включает. Не передавайте secrets в inline JSON без необходимости: аргумент может быть виден в process list. Предпочитайте защищённый config-файл или secret-aware environment/deployment mechanism.

MCP tools выполняются с правами процесса llama-server. Для доступа к `/tools` задайте `--api-key`, оставьте локальный bind или контролируемый reverse proxy и минимизируйте права дочерних команд.

## Диагностика

- `failed to parse MCP config JSON`: проверьте JSON и shell quoting.
- Сервер не появился: убедитесь, что корневой key называется `mcpServers`, а `command` непустой.
- Duplicate warning: переименуйте запись либо оставьте её только в одном источнике.

## Пример

```bash
llama-server --model /models/model.gguf \
  --mcp-servers-json '{"mcpServers":{"echo":{"command":"python3","args":["/opt/mcp/echo.py"]}}}' \
  --api-key local-secret --host 127.0.0.1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-mcp.cpp`
- `llama.cpp/tools/server/server-tools.cpp`
- `llama.cpp/tools/server/tests/unit/test_mcp_servers.py`
- https://github.com/ggml-org/llama.cpp/pull/26062
