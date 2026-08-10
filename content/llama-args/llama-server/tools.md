---
schema: 1
primaryName: "--tools"
title: "--tools"
summary: "Включает экспериментальные built-in tools для Web UI/agents на endpoint `/tools`. Опасно в недоверенных окружениях, особенно с write и shell tools."
category: "Параметры llama-server"
valueType: "list"
estimation: "normal"
valueHint: "TOOL1,TOOL2,..."
aliases:
  - "--tools"
allowedValues: []
env:
  - "LLAMA_ARG_TOOLS"
related:
  - "--api-key"
  - "--cors-origins"
  - "--host"
  - "--tools-runtime"
  - "--ui"
  - "--ui-mcp-proxy"
---

# --tools

## Кратко

`--tools` разбирается через `parse_csv_row(value)` и записывает список в `common_params::server_tools`. Если список не пуст, `server.cpp` вызывает `tools.setup(...)`, регистрирует `GET /tools` и `POST /tools`, и выводит предупреждение о недоверенных окружениях.

## Оригинальная справка llama.cpp

```text
experimental: whether to enable built-in tools for AI agents - do not enable in untrusted environments (default: no tools)
specify "all" to enable all tools
available tools: read_file, file_glob_search, grep_search, exec_shell_command, write_file, edit_file, get_datetime, get_info
note: for security reasons, this will limit --cors-origins to localhost by default
```

## Паспорт аргумента

- Основное имя: `--tools`
- Значение: CSV список имен tools или `all`
- Переменная окружения: `LLAMA_ARG_TOOLS`
- Поле в `common_params`: `server_tools`
- Значение по умолчанию: пустой список, endpoint не регистрируется
- Endpoints: `GET /tools`, `POST /tools`

## Что меняет в llama-server

`GET /tools` возвращает JSON-описания включенных tools. `POST /tools` принимает JSON body с `tool` и `params`, вызывает выбранный tool и возвращает результат.

Известные tools валидируются на старте. Неизвестное имя прерывает запуск с ошибкой `unknown tool "...". available tools: ...`.

## Доступные tools

- `read_file`: читает файл, максимум 16 KB без диапазона строк.
- `file_glob_search`: рекурсивный поиск файлов, максимум 100 результатов.
- `grep_search`: regex-поиск по файлам, максимум 100 совпадений.
- `exec_shell_command`: выполняет shell command через `sh -c` или `cmd /c`, максимум 60 секунд и 16 KB вывода.
- `write_file`: создает или перезаписывает файл, создает parent directories.
- `edit_file`: применяет один или несколько непересекающихся exact-text replacements; каждый `old_text` должен быть уникален, при расхождении допускается ограниченная нормализация whitespace/типографики.
- `get_datetime`: возвращает текущее время.
- `get_info`: возвращает сведения о runtime-среде сервера, включая ОС и текущий рабочий каталог.

## Значения и формат

Примеры значений: `read_file,grep_search`, `get_datetime`, `all`. Запятые разделяют элементы; пробелы в именах tools не используются.

## Когда использовать

Включайте только локально или в жестко изолированной среде, где доверяете пользователям и модели/agent workflow. `exec_shell_command`, `write_file` и `edit_file` дают возможность выполнять команды или менять файловую систему от имени процесса `llama-server`; `--tools-runtime` позволяет вынести их выполнение в Docker-изолят вместо хоста.

## Влияние на производительность и память

На инференс напрямую не влияет. Запущенные tools могут грузить CPU, диск, создавать процессы и конкурировать с моделью за ресурсы. Shell-команды ограничены timeout/output cap, но все равно могут менять состояние системы.

## Взаимодействие с другими аргументами

- `--tools-runtime`: направляет I/O tools в Docker-контейнер вместо файловой системы и shell хоста.
- `--api-key` практически обязателен при включении `/tools`.
- `--host 127.0.0.1` предпочтителен; не публикуйте tools на `0.0.0.0` без reverse proxy и policy.
- Если `--cors-origins` не задан явно, непустой список tools автоматически ограничивает CORS специальным origin `localhost`.
- UI может использовать endpoint, но сам endpoint регистрируется независимо от `--ui`.

## INI-пресеты и router-режим

В INI: `tools = read_file,grep_search` или `tools = all`. В router-режиме tools регистрируются на процессе, где применен аргумент; для публичного router-а это особенно рискованно, потому что endpoint находится рядом с модельным API.

## Типовые проблемы и диагностика

- `/tools` возвращает 403: список tools пуст или аргумент не применился; disabled route остаётся зарегистрированным как запрет.
- `unknown tool`: проверьте имя и запятые.
- Tool возвращает `failed to open file` или `path does not exist`: путь относится к файловой системе процесса `llama-server`.
- Команда обрезана: `exec_shell_command` ограничивает output и добавляет `[output truncated]`.

## Примеры

```bash
llama-server --model /models/model.gguf --tools read_file,grep_search --api-key local-secret
llama-server --model /models/model.gguf --tools all --host 127.0.0.1
curl http://127.0.0.1:8080/tools -H "Authorization: Bearer local-secret"
curl -X POST http://127.0.0.1:8080/tools -H "Authorization: Bearer local-secret" -d '{"tool":"get_datetime","params":{}}'
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-tools.cpp`
- `llama.cpp/tools/server/README.md`
- `llama.cpp/tools/server/README-dev.md`
- https://github.com/ggml-org/llama.cpp/pull/25498
