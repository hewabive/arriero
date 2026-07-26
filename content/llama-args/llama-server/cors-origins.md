---
schema: 1
primaryName: "--cors-origins"
title: "--cors-origins"
summary: "Задаёт разрешённые browser origins для CORS. Специальное значение `localhost` отражает только локальные origins; открытый default `*` требует осторожности."
category: "Параметры llama-server"
valueType: "list"
valueHint: "ORIGINS"
aliases:
  - "--cors-origins"
allowedValues: []
env:
  - "LLAMA_ARG_CORS_ORIGINS"
related:
  - "--cors-methods"
  - "--cors-headers"
  - "--cors-credentials"
  - "--api-key"
  - "--tools"
  - "--agent"
---

# --cors-origins

## Кратко

`--cors-origins` задаёт значение `common_params::cors_origins`, по которому HTTP middleware формирует `Access-Control-Allow-Origin`. По умолчанию используется `*`.

Если включены built-in tools или MCP servers и пользователь явно не передал этот аргумент, llama.cpp автоматически меняет origin на специальное значение `localhost`.

## Оригинальная справка llama.cpp

```text
comma-separated list of allowed origins for CORS (default: *)
if set to special value 'localhost', reflect the Origin header only if it is localhost
```

## Паспорт аргумента

- Основное имя: `--cors-origins`
- Значение: `ORIGINS`
- Переменная окружения: `LLAMA_ARG_CORS_ORIGINS`
- Поля: `common_params::cors_origins`, `cors_origins_explicit`
- Значение по умолчанию: `*`
- Специальное значение: `localhost`

## Что меняет в llama-server

- При `--cors-origins localhost` сервер разбирает заголовок `Origin` и отражает его только для host `localhost`, `127.0.0.1` или `::1` с любым портом. Для другого origin заголовок `Access-Control-Allow-Origin` не добавляется.
- При `*` вместе с включёнными credentials сервер отражает фактический `Origin`, потому что browser CORS запрещает комбинацию literal `*` и credentials.
- Для любого другого значения middleware записывает его в `Access-Control-Allow-Origin` как настроено.

## Безопасный выбор

Для локального Web UI используйте `localhost`. Для одного доверенного frontend укажите его точный origin, например `https://ui.example.internal`. Default `*` вместе с отсутствующим `--api-key` вызывает security warning и не подходит для listener-а в недоверенной сети.

`--api-key` не заменяет CORS-policy: CORS ограничивает браузеры, но не небраузерные клиенты.

## Взаимодействие с другими аргументами

- `--cors-credentials` определяет, разрешены ли browser credentials.
- `--cors-methods` и `--cors-headers` формируют ответ на preflight `OPTIONS`.
- `--tools` и `--agent` автоматически выбирают `localhost`, если origin не задан явно.
- `--api-key` защищает API-запросы независимо от CORS.

## INI-пресеты и router-режим

В INI:

```ini
cors-origins = localhost
```

CORS настраивается на внешнем listener-е router-а. Дочерним model-процессам browser обычно напрямую не обращается.

## Типовые проблемы и диагностика

- Browser не видит `Access-Control-Allow-Origin`: при режиме `localhost` origin не локальный или заголовок некорректен.
- В логах `(CORS) skip non-localhost origin`: запрос отклонён политикой `localhost`.
- Warning про `'*' and no API key`: задайте точный origin/`localhost` и API key.
- После включения tools origin неожиданно стал локальным: это защитный default; явный `--cors-origins` имеет приоритет.

## Примеры

```bash
llama-server --model /models/model.gguf --cors-origins localhost
llama-server --model /models/model.gguf --cors-origins https://ui.example.internal
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server.cpp`
- https://github.com/ggml-org/llama.cpp/pull/25655
