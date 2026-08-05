---
schema: 1
primaryName: "--models-max"
title: "--models-max"
summary: "Ограничивает число одновременно запущенных дочерних моделей в router-режиме. Значение 0 отключает лимит."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
presetSupport: "router-managed"
aliases:
  - "--models-max"
allowedValues: []
env:
  - "LLAMA_ARG_MODELS_MAX"
related:
  - "--models-dir"
  - "--models-preset"
  - "--models-autoload"
---

# --models-max

## Кратко

`--models-max` задает верхний предел одновременно работающих дочерних `llama-server` в router-режиме. По умолчанию лимит равен `4`; значение `0` означает без лимита.

## Оригинальная справка llama.cpp

```text
for router server, maximum number of models to load simultaneously (default: 4, 0 = unlimited)
```

## Паспорт аргумента

- Основное имя: `--models-max`
- Алиасы: `--models-max`
- Тип: `N`, целое число
- Переменная окружения: `LLAMA_ARG_MODELS_MAX`
- Значение по умолчанию: `4`
- Специальное значение: `0` отключает лимит
- Поле `common_params`: `models_max`
- Этап применения: router load/unload моделей
- Router-only: да

## Что меняет в llama-server

При загрузке модели router считает дочерние процессы со статусом running. Если лимит положительный и уже достигнут, router пытается освободить место через LRU-выгрузку: выбирает running-модель с самым старым `last_used` и вызывает unload.

После LRU есть повторная проверка под lock. Если конкурентные загрузки все равно достигли лимита, загрузка завершается ошибкой `model limit reached, try again later`.

## Значения и формат

Значение парсится как `int`. Практические значения:

- `0`: не ограничивать число одновременно загруженных моделей.
- `1`: держать только одну модель; новые запросы будут вытеснять предыдущую по LRU.
- `2..N`: ограничить параллельные модели доступной RAM/VRAM.

Отрицательные значения в коде обрабатываются так же, как отсутствие лимита, потому что проверка использует `models_max <= 0`. В конфигурации лучше использовать явное `0`: это документированная форма из `--help`.

## Когда использовать

Используйте `--models-max`, чтобы router не загрузил больше моделей, чем выдерживает память. Это особенно важно при `--models-autoload`, когда обычный запрос клиента может автоматически поднять новую модель.

Для публичного или многопользовательского API обычно нужен небольшой лимит и явный набор разрешенных моделей через `--models-preset`.

## Влияние на производительность и память

Меньший лимит снижает пиковое потребление RAM/VRAM, но увеличивает latency при переключении между моделями: router будет выгружать одну модель и загружать другую. Значение `0` удобно для тестового стенда, но на постоянном сервере может привести к исчерпанию памяти.

`--models-max` не ограничивает число моделей в каталоге `/models`; он ограничивает только активные дочерние процессы.

## Взаимодействие с другими аргументами

`--models-autoload` определяет, будет ли запрос автоматически загружать модель. Если autoload включен, `--models-max` срабатывает на обычных POST/GET запросах к модели. Если autoload выключен, лимит срабатывает при `POST /models/load`.

`load-on-startup = true` в `--models-preset` проверяется на старте. Если таких моделей больше, чем `--models-max`, router падает с ошибкой до обслуживания запросов.

## INI-пресеты и router-режим

`--models-max` является параметром router-процесса, а не отдельной модели. В модельном INI он удаляется из дочернего пресета и не должен использоваться для настройки конкретной модели.

Задавайте его на уровне запуска router:

```bash
llama-server --models-preset /srv/llama/models.ini --models-max 2
```

## Типовые проблемы и диагностика

- `model limit reached, try again later`: одновременные загрузки достигли лимита; повторите запрос позже или увеличьте `--models-max`.
- Частые выгрузки и долгие ответы: лимит слишком мал для рабочего набора моделей.
- OOM при `--models-max 0`: отключенный лимит позволил загрузить слишком много моделей.
- Ошибка на старте про `load on startup`: число моделей с `load-on-startup = true` превышает лимит.

Полезные строки логов: `models_max limit reached, removing LRU name=...`, `stopping model instance name=...`, `spawning server instance with name=...`.

## Примеры

```bash
llama-server --models-dir /srv/llama/models --models-max 1
```

```bash
llama-server --models-preset /srv/llama/models.ini --models-max 0
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--models-max`.
- `llama.cpp/common/common.h`: default `models_max = 4`.
- `llama.cpp/tools/server/server-models.cpp`: LRU unload, проверка лимита, startup autoload.
- `llama.cpp/tools/server/README.md`: router mode и preset-only `load-on-startup`.
