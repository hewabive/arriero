---
schema: 1
primaryName: "--slots"
title: "--slots"
summary: "Включает или отключает `GET /slots`, endpoint мониторинга состояния слотов. По умолчанию endpoint включен."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
presetSupport: "router-managed"
aliases:
  - "--slots"
  - "--no-slots"
allowedValues: []
env:
  - "LLAMA_ARG_ENDPOINT_SLOTS"
related:
  - "--api-key"
  - "--metrics"
  - "--parallel"
  - "--slot-save-path"
  - "--slot-prompt-similarity"
---

# --slots

## Кратко

`--slots` и `--no-slots` управляют `common_params::endpoint_slots`. По умолчанию значение `true`, поэтому `/slots` доступен без явного флага. `--no-slots` отключает read-only мониторинг слотов.

## Оригинальная справка llama.cpp

```text
expose slots monitoring endpoint (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--slots`
- Отрицательная форма: `--no-slots`
- Переменная окружения: `LLAMA_ARG_ENDPOINT_SLOTS`
- Поле в `common_params`: `endpoint_slots`
- Значение по умолчанию: enabled
- Endpoint: `GET /slots`

## Что меняет в llama-server

`GET /slots` ставит high-priority задачу `SERVER_TASK_TYPE_METRICS` и возвращает массив с состоянием каждого слота: всегда присутствуют `id`, `n_ctx`, `speculative`, `is_processing`; если у слота есть текущая или предыдущая задача, добавляются `id_task`, `n_prompt_tokens`, `n_prompt_tokens_processed`, `n_prompt_tokens_cache`, `params` и `next_token`.

По умолчанию `/slots` не раскрывает текст промпта и сгенерированный текст: ответ собирается через `slot.to_json(only_metrics = slots_debug == 0)`, и поля `prompt`/`generated` включаются только при ненулевой переменной окружения `LLAMA_SERVER_SLOTS_DEBUG`.

Если query `fail_on_no_slot` непустой и нет idle slots, обработчик возвращает `no slot available` (`ERROR_TYPE_UNAVAILABLE`, HTTP 503).

## Значения и формат

На CLI используйте `--slots` или `--no-slots`. В INI boolean-значение `false` будет преобразовано в отрицательный аргумент, потому что у опции есть `--no-slots`.

## Когда использовать

Оставляйте включенным на локальном или защищенном сервере для диагностики очередей, зависших запросов и распределения нагрузки. Отключайте на публичных endpoints, если не хотите раскрывать sampling-параметры и счетчики токенов; текст промптов и генерации по умолчанию скрыт и появляется только при включенной `LLAMA_SERVER_SLOTS_DEBUG`.

## Влияние на производительность и память

Сам флаг не влияет на инференс. Частые запросы `/slots` добавляют служебные tasks и JSON-сериализацию состояния; для обычного мониторинга это дешево.

## Взаимодействие с другими аргументами

- `--parallel` определяет количество слотов.
- `--slot-prompt-similarity` влияет на выбор слота, что видно по логам и состоянию.
- `--slot-save-path` нужен для `POST /slots/{id}?action=save|restore|erase`, но read-only `/slots` управляется этим флагом отдельно.
- `--api-key` защищает `/slots`.

## INI-пресеты и router-режим

В INI: `slots = true` или `slots = false`. В router-режиме `GET /slots?model=<id>` проксируется к конкретной модели; без query `model` router отвечает `model name is missing from the request` (HTTP 400).

## Типовые проблемы и диагностика

- ``This server does not support slots endpoint. Start it with `--slots` ``: сервер запущен с `--no-slots`; HTTP 501 (`ERROR_TYPE_NOT_SUPPORTED`).
- `no slot available`: запрос был с `?fail_on_no_slot=1`, и все слоты заняты; HTTP 503 (`ERROR_TYPE_UNAVAILABLE`).
- В ответе меньше слотов, чем ожидалось: проверьте `--parallel`; при `-np -1` сервер ставит auto-значение `4` и `kv_unified = true`.

## Примеры

```bash
llama-server --model /models/model.gguf --slots
llama-server --model /models/model.gguf --no-slots
curl http://127.0.0.1:8080/slots
curl "http://127.0.0.1:8080/slots?fail_on_no_slot=1"
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-common.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
