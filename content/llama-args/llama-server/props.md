---
schema: 1
primaryName: "--props"
title: "--props"
summary: "Разрешает `POST /props`; `GET /props` доступен и без этого флага. В текущем коде POST подтверждает успех, но не меняет полезные свойства."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
presetSupport: "router-managed"
aliases:
  - "--props"
allowedValues: []
env:
  - "LLAMA_ARG_ENDPOINT_PROPS"
related:
  - "--api-key"
  - "--metrics"
  - "--slots"
  - "--ui-config"
  - "--ui-mcp-proxy"
---

# --props

## Кратко

`--props` устанавливает `common_params::endpoint_props = true`. Важно: он разрешает только изменение через `POST /props`; `GET /props` read-only работает без флага и возвращает свойства сервера.

## Оригинальная справка llama.cpp

```text
enable changing global properties via POST /props (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--props`
- Тип: флаг без значения
- Переменная окружения: `LLAMA_ARG_ENDPOINT_PROPS`
- Поле в `common_params`: `endpoint_props`
- Значение по умолчанию: disabled
- Endpoint: `POST /props`

## Что меняет в llama-server

Без флага `POST /props` отвечает `This server does not support changing global properties. Start it with --props`. С флагом текущий обработчик возвращает `{"success": true}`, но блок `update any props here` не содержит реального изменения параметров.

`GET /props` возвращает `default_generation_settings`, `total_slots`, `model_alias`, `model_path`, `modalities`, `media_marker`, признаки включенных endpoints, UI-настройки, chat template, build info, `is_sleeping` и `cors_proxy_enabled`.

## Значения и формат

Флаг не принимает значение и не имеет `--no-props`.

## Когда использовать

В текущем состоянии включайте только если клиент ожидает наличие writable `/props` и вы проверили, что это действительно нужно. Для диагностики свойств сервера флаг не нужен: достаточно `GET /props`.

## Влияние на производительность и память

На инференс не влияет. `GET /props` доступен во время sleeping state и не должен трогать контекст модели в небезопасный момент.

## Взаимодействие с другими аргументами

- `--ui-config` и `--ui-config-file` отражаются в `ui_settings` ответа `/props`.
- `--ui-mcp-proxy` отражается как `cors_proxy_enabled`.
- `--slots` и `--metrics` отражаются как `endpoint_slots` и `endpoint_metrics`.
- `--api-key` защищает `/props`, потому что `/props` не входит в public endpoints middleware.

## INI-пресеты и router-режим

В INI: `props = true`. В router-режиме `GET /props` без `model` возвращает свойства router-а; с `?model=<id>` запрос проксируется к выбранной модели. `POST /props` в router-режиме также проксируется.

## Типовые проблемы и диагностика

- `POST /props` возвращает not supported: сервер запущен без `--props`.
- `GET /props` работает, но не показывает ожидаемую модель: в router-режиме добавьте `?model=<model_id>`.
- Клиент ожидает изменение параметров через POST: проверьте текущий код, потому что обработчик пока не обновляет конкретные свойства.

## Примеры

```bash
llama-server --model /models/model.gguf
curl http://127.0.0.1:8080/props
llama-server --model /models/model.gguf --props
curl -X POST http://127.0.0.1:8080/props -d '{}'
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
