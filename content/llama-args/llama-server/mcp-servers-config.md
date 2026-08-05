---
schema: 1
primaryName: "--mcp-servers-config"
title: "--mcp-servers-config"
summary: "Загружает Cursor-совместимый JSON-файл с командами локальных stdio MCP-серверов и публикует обнаруженные tools через `/tools`."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "PATH"
aliases:
  - "--mcp-servers-config"
allowedValues: []
env:
  - "LLAMA_ARG_MCP_SERVERS_CONFIG"
related:
  - "--mcp-servers-json"
  - "--tools"
  - "--api-key"
  - "--cors-origins"
---

# --mcp-servers-config

## Кратко

`--mcp-servers-config` читает JSON-файл в Cursor-совместимом формате `mcpServers`. Для каждой записи llama-server запускает локальный дочерний процесс и общается с ним по MCP JSON-RPC через stdin/stdout. Обнаруженные MCP tools добавляются к endpoint `/tools` с именем `<server>_<tool>`.

## Оригинальная справка llama.cpp

```text
experimental: path to JSON file with MCP server definitions (Cursor-compatible format) - do not enable in untrusted environments (default: none)
note: for security reasons, this will limit --cors-origins to localhost by default
```

## Паспорт аргумента

- Основное имя: `--mcp-servers-config`
- Значение: путь к JSON-файлу
- Переменная окружения: `LLAMA_ARG_MCP_SERVERS_CONFIG`
- Поле в `common_params`: `mcp_servers_config`
- Значение по умолчанию: пусто, MCP-процессы не запускаются
- Транспорт: локальный stdio subprocess

## Формат и поведение

Корневой объект должен содержать `mcpServers`. У каждой записи обязательна непустая `command`; поддерживаются массив строк `args`, объект строк `env`, `cwd` и `timeout_ms`. Запись без команды пропускается. При старте llama-server даёт каждому серверу до 10 секунд на запуск и `tools/list`; недоступный процесс логируется и не останавливает основной server.

```json
{
  "mcpServers": {
    "local": {
      "command": "python3",
      "args": ["/opt/mcp/server.py"],
      "cwd": "/opt/mcp",
      "env": { "MODE": "readonly" }
    }
  }
}
```

Имена server должны быть уникальны между файлом и `--mcp-servers-json`; повторная запись пропускается. При вызове tool процесс создаётся или переиспользуется, а после аварии действует короткий cooldown перед повторным запуском.

## Влияние на память и безопасность

Параметр не меняет веса, KV-cache или VRAM модели. Однако каждый MCP server — отдельный дочерний процесс с собственными RAM/CPU/файловыми правами; его потребление не входит в оценку памяти модели и должно учитываться как динамическая внешняя нагрузка.

Не включайте механизм в недоверенной среде. Команды выполняются от имени пользователя llama-server, а MCP tools становятся доступны через `/tools`. Ограничьте bind/CORS, задайте `--api-key`, используйте минимальные права и не помещайте секреты прямо в репозиторий.

## Диагностика

- `failed to open MCP config file`: путь недоступен процессу.
- `failed to parse MCP config JSON`: JSON не разобран.
- `MCP warmup: failed to spawn`: команда или рабочий каталог неверны.
- `MCP config: duplicate server name`: одно имя встретилось в двух источниках.
- Tool отсутствует в `/tools`: проверьте `MCP warmup` и результат `tools/list` в логах.

## Пример

```bash
llama-server --model /models/model.gguf \
  --mcp-servers-config /etc/llama/mcp.json \
  --api-key local-secret --host 127.0.0.1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-mcp.cpp`
- `llama.cpp/tools/server/server-tools.cpp`
- `llama.cpp/tools/server/tests/unit/test_mcp_servers.py`
- https://github.com/ggml-org/llama.cpp/pull/26062
