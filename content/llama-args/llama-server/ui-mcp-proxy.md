---
schema: 1
primaryName: "--ui-mcp-proxy"
title: "--ui-mcp-proxy"
summary: "Экспериментально включает MCP CORS proxy для Web UI на `/cors-proxy`. Не следует включать в недоверенной сети."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--ui-mcp-proxy"
  - "--webui-mcp-proxy"
  - "--no-ui-mcp-proxy"
  - "--no-webui-mcp-proxy"
allowedValues: []
env:
  - "LLAMA_ARG_UI_MCP_PROXY"
related:
  - "--ui"
  - "--agent"
  - "--api-key"
  - "--host"
---

# --ui-mcp-proxy

## Кратко

`--ui-mcp-proxy` и `--no-ui-mcp-proxy` управляют единственным полем `common_params::ui_mcp_proxy`. При включении сервер регистрирует `GET /cors-proxy` и `POST /cors-proxy`. `--webui-mcp-proxy`/`--no-webui-mcp-proxy` — равноправные алиасы (раньше были deprecated).

## Оригинальная справка llama.cpp

```text
experimental: whether to enable MCP CORS proxy - do not enable in untrusted environments (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--ui-mcp-proxy`
- Алиас: `--webui-mcp-proxy`
- Отрицательная форма: `--no-ui-mcp-proxy` (алиас `--no-webui-mcp-proxy`)
- Переменная окружения: `LLAMA_ARG_UI_MCP_PROXY`
- Поле в `common_params`: `ui_mcp_proxy`
- Значение по умолчанию: disabled
- Endpoints: `/cors-proxy`

## Что меняет в llama-server

После регистрации основных API routes `server.cpp` проверяет `params.ui_mcp_proxy`. Если true, сервер выводит предупреждение `CORS proxy is enabled, do not expose server to untrusted environments` и регистрирует proxy handlers.

`GET /props` отражает состояние как `cors_proxy_enabled`.

## Значения и формат

На CLI используйте `--ui-mcp-proxy` или `--no-ui-mcp-proxy`. В INI: `ui-mcp-proxy = true/false`.

## Когда использовать

Только для локального UI-сценария, где браузерному интерфейсу нужно обращаться к MCP-серверу через CORS proxy. Не включайте на публичном listener без строгой сетевой изоляции и `--api-key`.

## Влияние на производительность и память

На инференс не влияет. Включает дополнительную HTTP-поверхность, способную проксировать запросы, поэтому основной риск связан с безопасностью и исходящими запросами из окружения сервера.

## Взаимодействие с другими аргументами

- `--ui` не является строгим техническим условием регистрации `/cors-proxy`, но фича предназначена для Web UI.
- `--webui-mcp-proxy` — алиас, управляет тем же полем.
- `--agent` включает этот proxy заодно со всеми встроенными tools.
- `--api-key` защищает endpoint, если ключи включены.

## INI-пресеты и router-режим

В INI: `ui-mcp-proxy = true`. В router-режиме proxy включается на внешнем router listener, а `/props` router-а показывает `cors_proxy_enabled`.

## Типовые проблемы и диагностика

- `/cors-proxy` возвращает 403: флаг не включен; disabled route остаётся зарегистрированным как запрет.
- В логах предупреждение о CORS proxy: это ожидаемо при включении.
- Браузер все равно блокирует запрос: проверьте URL proxy и CORS требования MCP-сервера.

## Примеры

```bash
llama-server --model /models/model.gguf --ui-mcp-proxy --api-key local-secret
llama-server --model /models/model.gguf --no-ui-mcp-proxy
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-models.h`
- `llama.cpp/tools/server/tests/unit/test_proxy.py`
