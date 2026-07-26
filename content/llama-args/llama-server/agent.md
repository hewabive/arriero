---
schema: 1
primaryName: "--agent"
title: "--agent"
summary: "Шорткат «агентного» режима: одним флагом включает все встроенные tools (`--tools all`) и MCP CORS proxy (`--ui-mcp-proxy`). Экспериментально и опасно в недоверенной сети."
category: "Параметры llama-server"
valueType: "boolean"
valueHint: null
aliases:
  - "-ag"
  - "--agent"
  - "-no-ag"
  - "--no-agent"
allowedValues: []
env:
  - "LLAMA_ARG_AGENT"
related:
  - "--tools"
  - "--ui-mcp-proxy"
  - "--cors-origins"
  - "--ui"
  - "--api-key"
---

# --agent

## Кратко

`--agent` (`-ag`) — это не отдельное состояние, а удобный шорткат, который сразу включает два экспериментальных механизма для агентных сценариев Web UI: все встроенные tools и MCP CORS proxy. Обработчик не хранит собственного поля: при `true` он выставляет `params.server_tools = {"all"}` и `params.ui_mcp_proxy = true`, при `false` (`--no-agent`/`-no-ag`) очищает оба. По умолчанию выключено.

## Оригинальная справка llama.cpp

```text
whether to enable CORS proxy and all built-in tools - do not enable in untrusted environments (default: disabled)
note: for security reasons, this will limit --cors-origins to localhost by default
```

## Паспорт аргумента

- Основное имя: `--agent`
- Алиас: `-ag`
- Отрицательная форма: `--no-agent` (алиас `-no-ag`)
- Переменная окружения: `LLAMA_ARG_AGENT`
- Поля в `common_params`: пишет в `server_tools` и `ui_mcp_proxy` (собственного поля нет)
- Значение по умолчанию: disabled
- Endpoints: `/tools` (GET/POST) и `/cors-proxy` (GET/POST)

## Что меняет в llama-server

При включении эффект эквивалентен одновременной передаче `--tools all` и `--ui-mcp-proxy`:

- `server.cpp` видит непустой `server_tools`, вызывает `tools.setup({"all"})` и регистрирует `GET /tools` и `POST /tools`.
- `ui_mcp_proxy = true` регистрирует `GET /cors-proxy` и `POST /cors-proxy`.
- общий warning перечисляет включённые экспериментальные возможности и напоминает не публиковать сервер в недоверенной сети.
- если origin не задан явно, post-processing устанавливает `cors_origins = "localhost"`.

Доступные встроенные tools: `read_file`, `file_glob_search`, `grep_search`, `exec_shell_command`, `write_file`, `edit_file`, `get_datetime`. `exec_shell_command`, `write_file` и `edit_file` дают модели запись в файловую систему и выполнение команд на хосте сервера — это полноценный RCE-вектор, если listener доступен из недоверенной сети.

## Значения и формат

На CLI: `--agent` / `-ag` либо `--no-agent` / `-no-ag`. В INI: `agent = true/false`.

`--agent` — грубый «всё включить»: если нужен только подмножество tools, задавайте `--tools read_file,grep_search` напрямую вместо `--agent`. При смешивании порядок важен — последний примененный из `--agent`/`--tools`/`--no-agent` побеждает, потому что они пишут в одно поле `server_tools`.

## Когда использовать

Только для локальной агентной работы из встроенного Web UI, где модели намеренно дают tools и CORS proxy. Не включайте на публичном или многопользовательском listener. Если все же нужно — изолируйте сеть и закройте сервер `--api-key`.

## Влияние на производительность и память

На инференс не влияет. Добавляет HTTP-поверхность (`/tools`, `/cors-proxy`); основной эффект — риск безопасности, а не стоимость вычислений.

## Взаимодействие с другими аргументами

- `--tools` задает точный список tools; `--agent` — это эквивалент `--tools all` плюс proxy.
- `--ui-mcp-proxy` включает только CORS proxy без tools; `--agent` включает и его.
- `--cors-origins` можно задать явно; иначе agent mode ограничивает browser origins локальными адресами.
- `--ui` не обязателен для регистрации endpoint'ов, но весь сценарий рассчитан на работу из Web UI.
- `--api-key` защищает endpoints, если ключи включены.

## Типовые проблемы и диагностика

- В логах общий блок `the following feature(s) are enabled`: ожидаемо при `--agent`.
- `/tools` или `/cors-proxy` возвращают 403: соответствующая возможность выключена; disabled routes остаются зарегистрированными как запрет.
- `tools setup failed: ...` в логах: ошибка инициализации встроенных tools, сервер завершится с ненулевым кодом.

## Примеры

```bash
llama-server --model /models/model.gguf --agent --api-key local-secret
llama-server --model /models/model.gguf -no-ag
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-tools.cpp`
- https://github.com/ggml-org/llama.cpp/pull/25655
