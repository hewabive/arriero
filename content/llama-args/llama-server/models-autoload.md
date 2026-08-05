---
schema: 1
primaryName: "--models-autoload"
title: "--models-autoload"
summary: "Управляет автоматической загрузкой модели по router-запросу. Парный `--no-models-autoload` требует предварительного `POST /models/load` или per-request `autoload=true`."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
presetSupport: "router-managed"
aliases:
  - "--models-autoload"
  - "--no-models-autoload"
allowedValues: []
env:
  - "LLAMA_ARG_MODELS_AUTOLOAD"
related:
  - "--models-dir"
  - "--models-preset"
  - "--models-max"
---

# --models-autoload

## Кратко

`--models-autoload` включает автоматическую загрузку модели, когда router получает запрос к unloaded модели. По умолчанию включено. `--no-models-autoload` отключает это поведение глобально.

## Оригинальная справка llama.cpp

```text
for router server, whether to automatically load models (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--models-autoload`
- Отрицательная форма: `--no-models-autoload`
- Тип: boolean flag
- Переменная окружения: `LLAMA_ARG_MODELS_AUTOLOAD`
- Значение по умолчанию: `true`
- Поле `common_params`: `models_autoload`
- Этап применения: router validation перед proxy request
- Router-only: да

## Что меняет в llama-server

При POST-запросах router берет имя модели из JSON-поля `model`. При GET-запросах берет query parameter `model`. Затем `router_validate_model()` проверяет, существует ли модель в каталоге.

Если модель существует, но не загружена:

- при autoload `true` router вызывает `ensure_model_ready()` и запускает дочерний сервер;
- при autoload `false` router отвечает ошибкой `model is not loaded`.

Для одного запроса поведение можно переопределить query-параметром `?autoload=true` или `?autoload=false`.

## Значения и формат

CLI формы:

```bash
llama-server --models-autoload
llama-server --no-models-autoload
```

В env и INI boolean-значения проходят через общий parser boolean. В INI отрицательная форма тоже допустима:

```ini
models-autoload = false
no-models-autoload = true
```

На практике задавайте этот параметр на уровне router-процесса, а не в модельной секции.

## Когда использовать

Оставляйте autoload включенным для локальной разработки и небольшого доверенного набора моделей: клиенту достаточно указать `model`, router сам поднимет нужный дочерний процесс.

Отключайте autoload для публичных серверов, больших каталогов и дорогих моделей. Тогда загрузка становится явным административным действием через `POST /models/load`, а обычный запрос не сможет внезапно занять память.

## Влияние на производительность и память

Включенный autoload повышает удобство, но первый запрос к unloaded модели получает latency загрузки весов и KV-настроек. Также он может вытеснить другую модель через `--models-max`.

Отключенный autoload стабилизирует latency для уже loaded моделей и снижает риск неожиданных OOM, но требует отдельного шага загрузки.

## Взаимодействие с другими аргументами

`--models-max` ограничивает, сколько autoload-моделей могут одновременно работать. При достижении лимита router применяет LRU-выгрузку или возвращает ошибку.

`load-on-startup = true` из `--models-preset` не зависит от `--models-autoload`: такие модели загружаются при старте или reload списка.

`?autoload=true|false` в query string переопределяет глобальный `--models-autoload` для конкретного router-запроса.

## INI-пресеты и router-режим

`--models-autoload` является настройкой router, а не конкретной модели. Перед запуском дочернего процесса router удаляет `LLAMA_ARG_MODELS_AUTOLOAD` из модельного пресета.

Для автозагрузки конкретной модели при старте используйте preset-only ключ:

```ini
[coder]
model = /srv/models/qwen.gguf
load-on-startup = true
```

## Типовые проблемы и диагностика

- Ответ `model is not loaded`: autoload выключен; загрузите модель через `POST /models/load` или добавьте `?autoload=true`.
- Первый запрос слишком медленный: модель поднимается автоматически; предварительно загрузите ее.
- Неожиданная выгрузка другой модели: autoload активировал LRU из-за `--models-max`.
- Запрос без имени модели: router вернет `model name is missing from the request`.

## Примеры

```bash
llama-server --models-preset /srv/llama/models.ini --no-models-autoload
```

```bash
curl -X POST http://127.0.0.1:8080/models/load \
  -H "Content-Type: application/json" \
  -d '{"model":"coder"}'
```

```bash
curl "http://127.0.0.1:8080/props?model=coder&autoload=false"
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--models-autoload` и `--no-models-autoload`.
- `llama.cpp/common/common.h`: default `models_autoload = true`.
- `llama.cpp/tools/server/server-models.cpp`: `is_autoload`, `router_validate_model`, `ensure_model_ready`.
- `llama.cpp/tools/server/README.md`: `Routing requests`.
