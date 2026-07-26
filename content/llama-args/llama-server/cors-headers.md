---
schema: 1
primaryName: "--cors-headers"
title: "--cors-headers"
summary: "Задаёт `Access-Control-Allow-Headers` для browser CORS preflight. Default `*` разрешает запрошенные браузером заголовки."
category: "Параметры llama-server"
valueType: "list"
valueHint: "HEADERS"
aliases:
  - "--cors-headers"
allowedValues: []
env:
  - "LLAMA_ARG_CORS_HEADERS"
related:
  - "--cors-origins"
  - "--cors-methods"
  - "--cors-credentials"
  - "--api-key"
---

# --cors-headers

## Кратко

`--cors-headers` задаёт строку `common_params::cors_headers`, которую сервер возвращает как `Access-Control-Allow-Headers` на preflight `OPTIONS`.

## Оригинальная справка llama.cpp

```text
comma-separated list of allowed headers for CORS (default: *)
```

## Паспорт аргумента

- Основное имя: `--cors-headers`
- Значение: список HTTP header names через запятую
- Переменная окружения: `LLAMA_ARG_CORS_HEADERS`
- Поле: `common_params::cors_headers`
- Значение по умолчанию: `*`
- Этап применения: ответ на CORS preflight

## Что меняет в llama-server

Настройка определяет, какие нестандартные request headers браузер разрешит frontend-коду отправить после preflight. Для OpenAI-compatible клиентов обычно нужны `Content-Type` и `Authorization`; Anthropic-compatible клиент может использовать `X-Api-Key`.

Это не список response headers и не механизм аутентификации. Сервер по-прежнему отдельно проверяет API key у целевого запроса.

## Когда менять

Оставляйте `*` для простого локального развёртывания. В контролируемом web deployment можно задать явный минимум, например `Content-Type, Authorization`, и добавить `X-Api-Key`, если он используется клиентом.

## Взаимодействие с другими аргументами

- `--cors-origins` ограничивает browser origins.
- `--cors-methods` разрешает HTTP methods.
- `--cors-credentials` управляет credentialed CORS.
- `--api-key`/`--api-key-file` выполняют реальную проверку ключа после preflight.

## Типовые проблемы и диагностика

- Browser сообщает, что header не разрешён: добавьте имя из `Access-Control-Request-Headers`.
- `curl` работает, browser нет: проверьте preflight response, особенно `Authorization` и `Content-Type`.
- Явный список сломал Anthropic-клиент: добавьте `X-Api-Key`.

## Пример

```bash
llama-server --model /models/model.gguf \
  --cors-origins https://ui.example.internal \
  --cors-headers "Content-Type, Authorization, X-Api-Key"
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- https://github.com/ggml-org/llama.cpp/pull/25655
