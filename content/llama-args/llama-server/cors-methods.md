---
schema: 1
primaryName: "--cors-methods"
title: "--cors-methods"
summary: "Задаёт содержимое `Access-Control-Allow-Methods` в ответах на browser CORS preflight. По умолчанию разрешены GET, POST, DELETE и OPTIONS."
category: "Параметры llama-server"
valueType: "list"
estimation: "normal"
valueHint: "METHODS"
aliases:
  - "--cors-methods"
allowedValues: []
env:
  - "LLAMA_ARG_CORS_METHODS"
related:
  - "--cors-origins"
  - "--cors-headers"
  - "--cors-credentials"
---

# --cors-methods

## Кратко

`--cors-methods` задаёт строку `common_params::cors_methods`. HTTP middleware возвращает её в заголовке `Access-Control-Allow-Methods` для preflight-запросов `OPTIONS`.

## Оригинальная справка llama.cpp

```text
comma-separated list of allowed methods for CORS (default: GET, POST, DELETE, OPTIONS)
```

## Паспорт аргумента

- Основное имя: `--cors-methods`
- Значение: список HTTP methods через запятую
- Переменная окружения: `LLAMA_ARG_CORS_METHODS`
- Поле: `common_params::cors_methods`
- Значение по умолчанию: `GET, POST, DELETE, OPTIONS`
- Этап применения: ответ на CORS preflight

## Что меняет в llama-server

Аргумент не включает и не отключает server routes. Он сообщает браузеру, какие методы разрешены CORS-policy. Небраузерный клиент и сам router продолжают видеть зарегистрированные endpoints независимо от этой строки.

Preflight `OPTIONS` обрабатывается до API-key validation, потому что браузеры обычно не прикладывают `Authorization` к preflight. Это не открывает целевой API-вызов: последующий запрос всё равно проходит обычную аутентификацию.

## Когда менять

Сужайте список, если frontend использует только часть методов и policy должна быть минимальной. Не удаляйте `OPTIONS`: браузеру нужен preflight. Если UI выполняет операции удаления, сохраните `DELETE`.

## Взаимодействие с другими аргументами

- `--cors-origins` определяет, для каких origins действует доступ.
- `--cors-headers` разрешает request headers preflight-а.
- `--cors-credentials` управляет `Access-Control-Allow-Credentials`.

## Типовые проблемы и диагностика

- Browser пишет `Method ... is not allowed`: добавьте фактически используемый метод.
- API работает через `curl`, но не из browser: сравните preflight response и эту настройку.
- Изменение не ограничило `curl`: ожидаемо, CORS исполняется браузером, а не серверной авторизацией.

## Пример

```bash
llama-server --model /models/model.gguf \
  --cors-origins https://ui.example.internal \
  --cors-methods "GET, POST, OPTIONS"
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-http.cpp`
- https://github.com/ggml-org/llama.cpp/pull/25655
