---
schema: 1
primaryName: "--ssl-key-file"
title: "--ssl-key-file"
summary: "PEM-файл приватного ключа для встроенного HTTPS listener. Работает только вместе с `--ssl-cert-file` и только в сборке с OpenSSL."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "FNAME"
presetSupport: "router-managed"
aliases:
  - "--ssl-key-file"
allowedValues: []
env:
  - "LLAMA_ARG_SSL_KEY_FILE"
related:
  - "--api-key"
  - "--api-key-file"
  - "--host"
  - "--port"
  - "--ssl-cert-file"
---

# --ssl-key-file

## Кратко

`--ssl-key-file` записывает путь в `common_params::ssl_file_key`. HTTPS включается только если одновременно заданы непустые `ssl_file_key` и `ssl_file_cert`.

## Оригинальная справка llama.cpp

```text
path to file a PEM-encoded SSL private key
```

## Паспорт аргумента

- Основное имя: `--ssl-key-file`
- Значение: путь к PEM private key
- Переменная окружения: `LLAMA_ARG_SSL_KEY_FILE`
- Поле в `common_params`: `ssl_file_key`
- Значение по умолчанию: пустая строка
- Этап применения: создание `httplib::SSLServer`

## Что меняет в llama-server

В сборке с `CPPHTTPLIB_OPENSSL_SUPPORT` сервер создает `httplib::SSLServer(cert, key)` и логирует `running with SSL: key = ..., cert = ...`. Без полного комплекта ключ+сертификат сервер запускается как HTTP. В сборке без OpenSSL указание обоих файлов приводит к ошибке `the server is built without SSL support`.

## Значения и формат

Файл должен быть PEM-encoded private key, совместимый с сертификатом из `--ssl-cert-file`. Парсер аргументов не проверяет файл; ошибка чтения или несовпадение обнаруживается при создании SSL server.

## Когда использовать

Используйте для простого локального HTTPS или тестового стенда. Для публичного сервера часто надежнее завершать TLS на nginx, Caddy, Envoy или другом reverse proxy, а `llama-server` держать на `127.0.0.1`.

## Влияние на производительность и память

TLS добавляет стоимость handshake и шифрования HTTP-трафика, но обычно не влияет на вычислительную часть инференса. На VRAM и KV-cache не влияет.

## Взаимодействие с другими аргументами

- Требует `--ssl-cert-file`; один `--ssl-key-file` не включает HTTPS.
- `--api-key` все равно нужен для аутентификации.
- `--host 0.0.0.0` с TLS без ключа API остается опасным для публичной сети.

## INI-пресеты и router-режим

В INI: `ssl-key-file = /etc/llama/tls.key`. В router-режиме TLS должен быть у внешнего router listener; `server-models.cpp` удаляет SSL-параметры из дочерних preset-ов.

## Типовые проблемы и диагностика

- Сервер пишет `running without SSL`: не задан `--ssl-cert-file` или пустое значение.
- `the server is built without SSL support`: пересоберите llama.cpp с OpenSSL или используйте reverse proxy.
- Клиент получает TLS error: проверьте пару ключ/сертификат и доверие к self-signed сертификату.

## Примеры

```bash
llama-server --model /models/model.gguf --ssl-key-file /etc/llama/tls.key --ssl-cert-file /etc/llama/tls.crt
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
