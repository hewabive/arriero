---
schema: 1
primaryName: "--ui"
title: "--ui"
summary: "Включает или отключает встроенный Web UI. По умолчанию UI включен; API endpoints продолжают работать и при `--no-ui`."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
presetSupport: "router-managed"
aliases:
  - "--ui"
  - "--webui"
  - "--no-ui"
  - "--no-webui"
allowedValues: []
env:
  - "LLAMA_ARG_UI"
related:
  - "--path"
  - "--api-prefix"
  - "--ui-config"
  - "--ui-config-file"
  - "--ui-mcp-proxy"
  - "--agent"
---

# --ui

## Кратко

`--ui` и `--no-ui` управляют единственным полем `common_params::ui`. По умолчанию UI включен. `--webui`/`--no-webui` — равноправные алиасы того же флага: раньше они были помечены deprecated, теперь это просто вторые имена в одной записи `--help`.

## Оригинальная справка llama.cpp

```text
whether to enable the Web UI (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--ui`
- Алиас: `--webui`
- Отрицательная форма: `--no-ui` (алиас `--no-webui`)
- Переменная окружения: `LLAMA_ARG_UI`
- Поле в `common_params`: `ui`
- Значение по умолчанию: enabled
- Этап применения: регистрация static UI routes

## Что меняет в llama-server

Если UI отключен, сервер логирует `The UI is disabled` и не регистрирует static routes для `/`, `/bundle.js`, `/bundle.css` или mount point из `--path`. Все API routes (`/v1/chat/completions`, `/props`, `/slots` и другие) регистрируются независимо от UI.

Если UI включен, сервер либо монтирует каталог из `--path`, либо отдает встроенные ассеты, если бинарник собран с UI assets.

## Значения и формат

На CLI используйте `--ui` или `--no-ui`. В INI можно писать `ui = true` или `ui = false`.

## Когда использовать

Оставляйте UI включенным для локальной ручной работы. Отключайте на API-only сервисах, в production за отдельным frontend или когда не хотите отдавать браузерный интерфейс с того же процесса.

## Влияние на производительность и память

На инференс не влияет. Отключение UI убирает отдачу static assets и немного уменьшает публичную HTTP-поверхность.

## Взаимодействие с другими аргументами

- `--path` имеет эффект только при включенном UI.
- `--api-prefix` сдвигает UI routes под префикс.
- `--ui-config` и `--ui-config-file` задают настройки, которые видны в `/props`, но без UI они в основном полезны только клиентам, которые читают эти props.
- `--webui`/`--no-webui` — алиасы этого же флага (не deprecated).
- `--agent` включает server tools и CORS proxy и предполагает работу из Web UI.

## INI-пресеты и router-режим

В INI: `ui = false`. В router-режиме внешний UI обслуживается router-процессом; свойства router-а включают `ui_settings`.

## Типовые проблемы и диагностика

- `/` возвращает 404 или JSON error: проверьте, не запущен ли сервер с `--no-ui`.
- UI включен, но static каталог не найден: проверьте `--path`.
- UI не видит API за префиксом: проверьте `--api-prefix` и reverse proxy.

## Примеры

```bash
llama-server --model /models/model.gguf --no-ui
llama-server --model /models/model.gguf --ui --api-prefix /llama
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-context.cpp`
