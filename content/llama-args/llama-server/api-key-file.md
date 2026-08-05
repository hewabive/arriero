---
schema: 1
primaryName: "--api-key-file"
title: "--api-key-file"
summary: "Читает API-ключи из файла, по одному ключу на строку. Удобно для secret-файлов и rotation без записи секрета в argv."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "FNAME"
presetSupport: "router-managed"
aliases:
  - "--api-key-file"
allowedValues: []
env:
  - "LLAMA_ARG_API_KEY_FILE"
related:
  - "--api-key"
  - "--host"
  - "--port"
  - "--ssl-cert-file"
  - "--ssl-key-file"
---

# --api-key-file

## Кратко

`--api-key-file` открывает файл при парсинге аргументов и добавляет каждую непустую строку в `common_params::api_keys`. Строки, начинающиеся с `#`, считаются комментариями и пропускаются. Если файл нельзя открыть, запуск прерывается ошибкой `error: failed to open file '...'`.

## Оригинальная справка llama.cpp

```text
path to file containing API keys, one per line; lines starting with a hash are treated as comments (default: none)
```

## Паспорт аргумента

- Основное имя: `--api-key-file`
- Значение: путь к файлу
- Переменная окружения: `LLAMA_ARG_API_KEY_FILE`
- Поле в `common_params`: `api_keys`
- Значение по умолчанию: файл не задан
- Этап применения: парсинг CLI, до инициализации HTTP-сервера

## Что меняет в llama-server

После чтения файла поведение идентично `--api-key`: middleware требует `Authorization: Bearer <key>` или `X-Api-Key: <key>` для непубличных endpoints. Пустые строки игнорируются; строки, начинающиеся с `#`, считаются комментариями (проверяется только первый символ строки, inline-комментарии после ключа не поддержаны).

Файл читается один раз на старте. Изменение файла не обновляет ключи в уже работающем процессе.

## Значения и формат

Формат — по одному ключу на строку; строки с `#` в начале это комментарии:

```text
# prod keys
key-one
key-two
```

Используйте права доступа, ограничивающие чтение только пользователем сервиса. Относительные пути считаются относительно рабочего каталога `llama-server`.

## Когда использовать

Используйте в systemd, Docker secrets, Kubernetes projected secrets и других окружениях, где нежелательно хранить секрет в командной строке или env. Для одного локального теста проще `--api-key`.

## Влияние на производительность и память

Файл читается только при запуске. Дальше стоимость такая же, как у `--api-key`: проверка строки в списке ключей.

## Взаимодействие с другими аргументами

- Можно комбинировать с `--api-key`; все ключи складываются в один список.
- Для сетевого доступа используйте вместе с `--ssl-key-file`/`--ssl-cert-file` или TLS на reverse proxy.
- В router-режиме API-ключи принадлежат router-процессу, дочерние модельные процессы не должны публиковать собственную аутентификацию.

## INI-пресеты и router-режим

В INI: `api-key-file = /run/secrets/llama-api-keys`. В router-режиме ключи задавайте у router. Дочерние процессы запускаются на loopback и управляются router-ом.

## Типовые проблемы и диагностика

- `failed to open file`: неверный путь или права.
- `401 Invalid API Key`: в файле лишние пробелы, CRLF или клиент отправляет не тот заголовок.
- Rotation не сработал: перезапустите `llama-server`, потому что файл не перечитывается динамически.

## Примеры

```bash
llama-server --model /models/model.gguf --api-key-file /run/secrets/llama-api-keys
curl http://127.0.0.1:8080/v1/chat/completions -H "Authorization: Bearer key-one"
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
