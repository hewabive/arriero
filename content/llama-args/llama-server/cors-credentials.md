---
schema: 1
primaryName: "--cors-credentials"
title: "--cors-credentials"
summary: "Включает или отключает `Access-Control-Allow-Credentials` для browser CORS. По умолчанию credentials разрешены."
category: "Параметры llama-server"
valueType: "boolean"
valueHint: null
aliases:
  - "--cors-credentials"
  - "--no-cors-credentials"
allowedValues: []
env:
  - "LLAMA_ARG_CORS_CREDENTIALS"
related:
  - "--cors-origins"
  - "--cors-methods"
  - "--cors-headers"
  - "--api-key"
---

# --cors-credentials

## Кратко

`--cors-credentials` и `--no-cors-credentials` управляют `common_params::cors_credentials`. Для preflight server выставляет `Access-Control-Allow-Credentials: true` или `false`.

По умолчанию credentials включены.

## Оригинальная справка llama.cpp

```text
whether to allow credentials for CORS (default: enabled)
note: if this is enabled and --cors-origins is set to * (default), the Origin header will be echoed back, and credentials will always be allowed
```

## Паспорт аргумента

- Основное имя: `--cors-credentials`
- Отрицательная форма: `--no-cors-credentials`
- Переменная окружения: `LLAMA_ARG_CORS_CREDENTIALS`
- Поле: `common_params::cors_credentials`
- Значение по умолчанию: enabled
- Этап применения: CORS middleware и preflight response

## Что меняет в llama-server

При включённых credentials и `--cors-origins *` сервер не отправляет literal `*`: он отражает входной `Origin`, чтобы browser принял credentialed response. Поэтому default фактически разрешает credentials любому browser origin и требует защиты listener-а.

При отключении middleware возвращает `Access-Control-Allow-Credentials: false`; обычная API-key validation при этом не меняется.

## Когда использовать

Отключайте credentials, если frontend не использует cookies, HTTP auth или browser credential mode. Если credentials нужны, задавайте точный `--cors-origins` или `localhost`, а не открытый default.

Bearer/API keys, которые JavaScript явно кладёт в `Authorization`, всё равно должны быть разрешены через `--cors-headers` и проверяются сервером отдельно.

## Взаимодействие с другими аргументами

- `--cors-origins` определяет разрешённые browser origins.
- `--cors-methods` и `--cors-headers` формируют остальные preflight headers.
- `--api-key` является серверной аутентификацией и не заменяется CORS.

## Типовые проблемы и диагностика

- Browser запрещает credentialed request: проверьте этот флаг и точное совпадение origin.
- При `*` response отражает origin: это намеренный special case llama.cpp.
- После `--no-cors-credentials` cookie не отправляется/не принимается: ожидаемое browser-поведение.

## Примеры

```bash
llama-server --model /models/model.gguf \
  --cors-origins https://ui.example.internal \
  --cors-credentials

llama-server --model /models/model.gguf \
  --cors-origins "*" \
  --no-cors-credentials
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- https://github.com/ggml-org/llama.cpp/pull/25655
