---
schema: 1
primaryName: "--ssl-cert-file"
title: "--ssl-cert-file"
summary: "PEM-файл сертификата для встроенного HTTPS listener. Должен использоваться вместе с `--ssl-key-file`."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "FNAME"
presetSupport: "router-managed"
aliases:
  - "--ssl-cert-file"
allowedValues: []
env:
  - "LLAMA_ARG_SSL_CERT_FILE"
related:
  - "--api-key"
  - "--api-key-file"
  - "--host"
  - "--port"
  - "--ssl-key-file"
---

# --ssl-cert-file

## Кратко

`--ssl-cert-file` записывает путь в `common_params::ssl_file_cert`. HTTPS включается только при наличии и сертификата, и приватного ключа.

## Оригинальная справка llama.cpp

```text
path to file a PEM-encoded SSL certificate
```

## Паспорт аргумента

- Основное имя: `--ssl-cert-file`
- Значение: путь к PEM certificate
- Переменная окружения: `LLAMA_ARG_SSL_CERT_FILE`
- Поле в `common_params`: `ssl_file_cert`
- Значение по умолчанию: пустая строка
- Этап применения: создание `httplib::SSLServer`

## Что меняет в llama-server

В сборке с OpenSSL сервер создает HTTPS listener и формирует `listening_address` со схемой `https://`. Если указан только сертификат без ключа, сервер остается HTTP, потому что условие требует оба файла. Если OpenSSL в бинарнике отсутствует, пара SSL-файлов приводит к ошибке и остановке init.

## Значения и формат

Файл должен быть PEM-encoded сертификатом или цепочкой, которую принимает `cpp-httplib`/OpenSSL. Он должен соответствовать ключу из `--ssl-key-file`.

## Когда использовать

Используйте, если хотите, чтобы сам `llama-server` принимал HTTPS. В production чаще проще и гибче вынести TLS termination в reverse proxy, особенно если нужны автоматическое обновление сертификатов, HTTP/2, rate limiting и дополнительные access logs.

## Влияние на производительность и память

Влияет только на HTTP-шифрование. На загрузку модели, RAM/VRAM и скорость токенов не влияет.

## Взаимодействие с другими аргументами

- Требует `--ssl-key-file`.
- Дополняет, но не заменяет `--api-key` и сетевую изоляцию.
- С `--host 0.0.0.0` публикует HTTPS listener на все интерфейсы.

## INI-пресеты и router-режим

В INI: `ssl-cert-file = /etc/llama/tls.crt`. В router-режиме задавайте сертификат у router-процесса; дочерние модельные процессы получают локальные порты и не должны обслуживать внешний TLS.

## Типовые проблемы и диагностика

- URL в логе остался `http://`: не задан `--ssl-key-file`.
- Ошибка сборки без SSL: используйте reverse proxy или сборку с OpenSSL.
- Браузер ругается на сертификат: self-signed сертификат не доверен клиенту.

## Примеры

```bash
llama-server --model /models/model.gguf --ssl-cert-file /etc/llama/tls.crt --ssl-key-file /etc/llama/tls.key
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-http.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
