---
schema: 1
primaryName: "--api-key"
title: "--api-key"
summary: "Добавляет один или несколько API-ключей для HTTP-аутентификации. Ключи принимаются из `Authorization: Bearer ...` или `X-Api-Key`."
category: "Параметры llama-server"
valueType: "list"
estimation: "normal"
valueHint: "KEY"
presetSupport: "router-managed"
aliases:
  - "--api-key"
allowedValues: []
env:
  - "LLAMA_API_KEY"
related:
  - "--api-key-file"
  - "--host"
  - "--port"
  - "--ssl-cert-file"
  - "--ssl-key-file"
  - "--tools"
  - "--ui-mcp-proxy"
---

# --api-key

## Кратко

`--api-key` добавляет ключи в `common_params::api_keys`. Значение разбирается как CSV: `--api-key key1,key2`. Пустые элементы игнорируются.

Если список ключей пуст, middleware аутентификации отключен. Если список не пуст, большинство API endpoints требуют ключ.

## Оригинальная справка llama.cpp

```text
API key to use for authentication, multiple keys can be provided as a comma-separated list (default: none)
```

## Паспорт аргумента

- Основное имя: `--api-key`
- Значение: строка `KEY`, допускается список через запятую
- Переменная окружения: `LLAMA_API_KEY`
- Поле в `common_params`: `api_keys`
- Значение по умолчанию: ключи не заданы
- Этап применения: pre-routing middleware HTTP-сервера

## Что меняет в llama-server

При одном ключе сервер логирует только последние четыре символа (`api_keys: ****xxxx`). При нескольких ключах логирует количество. Middleware проверяет заголовок `Authorization`; префикс `Bearer ` удаляется. Если `Authorization` пуст, проверяется `X-Api-Key`.

OPTIONS-запросы пропускаются без проверки, чтобы CORS preflight работал из браузера. Несколько endpoints считаются публичными: `/health`, `/v1/health`, `/models`, `/v1/models`, `/`, `/index.html`, `/bundle.js`, `/bundle.css`.

## Значения и формат

Ключи сравниваются как точные строки. В CSV нет экранирования для запятых внутри ключа, поэтому не используйте запятую как часть секрета. Для ключей с пробелами или сложными символами лучше использовать `--api-key-file`.

## Когда использовать

Используйте всегда, если `--host` не равен локальному адресу или если на сервере включены опасные функции вроде `--tools` или `--ui-mcp-proxy`. Для публичного сервера дополнительно используйте TLS/reverse proxy; API-ключ без HTTPS передается по сети открытым текстом.

## Влияние на производительность и память

Проверка ключа выполняет линейный поиск по небольшому списку строк и не влияет на инференс. Большой список ключей увеличивает только микроскопическую стоимость middleware.

## Взаимодействие с другими аргументами

- `--api-key-file` дополняет тот же список ключей; можно использовать вместе с `--api-key`.
- `--ssl-key-file` и `--ssl-cert-file` защищают ключ в канале передачи.
- `--api-prefix` в этой версии не отражен в списке public endpoints middleware; при префиксе проверьте, какие маршруты требуют ключ.
- `--tools` и `--ui-mcp-proxy` не стоит включать без ключей и сетевой изоляции.

## INI-пресеты и router-режим

В INI можно писать `api-key = secret` или `LLAMA_API_KEY = secret`. В router-режиме ключ контролируется router-процессом; при подготовке дочерних модельных процессов `LLAMA_API_KEY` удаляется из preset, чтобы внешний доступ шел через router.

## Типовые проблемы и диагностика

- Ответ `401 Invalid API Key`: отсутствует заголовок, неверная строка или лишний пробел после `Bearer`.
- OpenAI SDK не подключается: проверьте `api_key` в клиенте и `base_url`.
- Антропик-совместимые клиенты могут использовать `X-Api-Key`; сервер это поддерживает.

## Примеры

```bash
llama-server --model /models/model.gguf --api-key local-secret
llama-server --model /models/model.gguf --api-key key-a,key-b
curl http://127.0.0.1:8080/v1/models -H "Authorization: Bearer local-secret"
curl http://127.0.0.1:8080/v1/messages -H "X-Api-Key: local-secret"
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
