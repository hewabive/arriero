---
schema: 1
primaryName: "--api-prefix"
title: "--api-prefix"
summary: "URL-префикс, добавляемый ко всем HTTP routes `llama-server`. Значение задается без завершающего слеша, например `/llama`."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "PREFIX"
presetSupport: "router-managed"
aliases:
  - "--api-prefix"
allowedValues: []
env:
  - "LLAMA_ARG_API_PREFIX"
related:
  - "--path"
  - "--ui"
---

# --api-prefix

## Кратко

`--api-prefix` записывается в `common_params::api_prefix` и затем в `server_http_context::path_prefix`. Все вызовы `ctx_http.get()` и `ctx_http.post()` регистрируют маршрут как `path_prefix + path`.

## Оригинальная справка llama.cpp

```text
prefix path the server serves from, without the trailing slash (default: )
```

## Паспорт аргумента

- Основное имя: `--api-prefix`
- Значение: строка `PREFIX`
- Переменная окружения: `LLAMA_ARG_API_PREFIX`
- Поле в `common_params`: `api_prefix`
- Значение по умолчанию: пустая строка
- Этап применения: регистрация HTTP routes

## Что меняет в llama-server

При `--api-prefix /llama` маршрут `/v1/chat/completions` становится `/llama/v1/chat/completions`, `/props` становится `/llama/props`, а встроенный UI открывается на `/llama/`. Завершающий слеш добавлять не нужно: код сам конкатенирует `prefix + "/..."`.

Парсер не нормализует значение. Если указать `llama` без начального `/`, получатся некорректные или неожиданные routes для HTTP-библиотеки. Если указать `/llama/`, появятся двойные слеши.

## Значения и формат

Рекомендуемый формат: пустая строка или путь вида `/llama`, `/api/llama`, без завершающего `/`. Значение не должно содержать query string.

## Когда использовать

Используйте за reverse proxy, когда `llama-server` размещается не в корне домена, например `https://example.org/llama/`. Для локального OpenAI-compatible клиента чаще проще оставить пустой префикс и задавать `base_url=http://127.0.0.1:8080/v1`.

## Влияние на производительность и память

На инференс не влияет. Ошибочный префикс может привести к 404 и сломанному UI, но не меняет загрузку модели.

## Взаимодействие с другими аргументами

- `--path` монтируется на `api_prefix + "/"`.
- `--ui` включает встроенные routes `/`, `/bundle.js`, `/bundle.css` под этим префиксом.
- `--api-key` middleware содержит список публичных endpoints без учета префикса; с `--api-prefix` и ключом проверьте доступ к `/health`, `/models` и UI в вашей версии.

## INI-пресеты и router-режим

В INI: `api-prefix = /llama`. В router-режиме префикс задается у внешнего router-процесса; проксируемые дочерние процессы получают запросы через router.

## Типовые проблемы и диагностика

- `404 File Not Found`: клиент обращается к старому URL без префикса.
- UI грузится без CSS/JS: reverse proxy не переписывает префикс одинаково для `/`, `/bundle.js` и API routes.
- Двойные слеши в URL: уберите завершающий `/` из значения.

## Примеры

```bash
llama-server --model /models/model.gguf --api-prefix /llama
curl http://127.0.0.1:8080/llama/v1/models
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server.cpp`
