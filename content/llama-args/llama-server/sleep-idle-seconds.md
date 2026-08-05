---
schema: 1
primaryName: "--sleep-idle-seconds"
title: "--sleep-idle-seconds"
summary: "Включает sleep-on-idle: после заданного числа секунд без задач сервер выгружает модель и KV-cache, а следующий запрос будит и перезагружает модель. `-1` отключает режим, `0` и значения меньше `-1` запрещены."
category: "Параметры llama-server"
valueType: "number"
valueHint: "SECONDS"
aliases:
  - "--sleep-idle-seconds"
allowedValues: []
env: []
related:
  - "--props"
  - "--models-preset"
  - "--models-dir"
  - "--cache-idle-slots"
---

# --sleep-idle-seconds

## Кратко

`--sleep-idle-seconds` включает автоматический sleep mode после простоя. Когда очередь задач не получает work дольше заданного интервала, `server_context` вызывает `destroy()`: освобождаются model/context state, speculative state, draft context и KV-cache. Новый запрос будит сервер и вызывает повторный `load_model(...)`.

Default `-1` отключает sleep. Значение `0` не допускается.

## Оригинальная справка llama.cpp

```text
number of seconds of idleness after which the server will sleep (default: -1; -1 = disabled)
```

## Паспорт аргумента

- Основное имя: `--sleep-idle-seconds`
- Алиасы: `--sleep-idle-seconds`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `number`
- Формат: целое число секунд
- Переменные окружения: нет
- Поле в `common_params`: `sleep_idle_seconds`
- Этап применения: server queue loop после старта HTTP server

## Что меняет в llama-server

В `common/arg.cpp` обработчик принимает int и отклоняет `0` или `< -1` с ошибкой `invalid value: cannot be 0 or less than -1`. В `tools/server/server-context.cpp` значение передается в `queue_tasks.start_loop(params.sleep_idle_seconds * 1000)`.

В `server-queue.cpp` sleep включен только если `idle_sleep_ms >= 0`. При входе в sleep логируется `entering sleeping state`, затем `server_context` логирует `server is entering sleeping state` и уничтожает загруженные ресурсы. При новом запросе `wait_until_no_sleep()` запрашивает выход из sleep, после чего модель загружается заново.

## Значения и формат

- `-1`: отключить sleep mode.
- `1` и больше: интервал простоя в секундах.
- `0`: запрещено, потому что привело бы к немедленному sleep loop.
- `< -1`: запрещено.

## Когда использовать

- На локальных или shared machines, где модель должна освобождать RAM/VRAM после периода неиспользования.
- В router mode, где редко используемые model instances должны спать, но оставаться доступными по запросу.
- Для дорогих больших моделей, если задержка cold wake приемлема.

## Влияние на производительность и память

Во время sleep освобождаются модель, context и KV-cache, поэтому RAM/VRAM падают. Первый запрос после sleep получает cold-start latency: модель снова читается с диска/cache и создается контекст. Если включены GPU offload и большой context, wake может занимать заметное время.

Статическая оценка Arriero при включенном sleep описывает **awake footprint** и возвращает `low` с явным предупреждением: наблюдаемое idle-состояние намеренно почти пустое и не должно сравниваться с загруженной моделью как estimator drift.

## Взаимодействие с другими аргументами

- `GET /props` показывает `is_sleeping`; в router mode используйте `/props?model=<model_name>`.
- README указывает, что `GET /health`, `GET /props` и `GET /models` не считаются incoming tasks: они не будят модель и не сбрасывают idle timer.
- В child server router mode sleep state отправляется router-у через stdout command markers.
- `--cache-idle-slots` решает другую задачу: сохранение idle slots в prompt cache перед новой задачей; это не замена sleep mode.

## INI-пресеты и router-режим

```ini
[*]
sleep-idle-seconds = 300
```

В router mode sleep работает для single-model child instances и отражается в router props. Для моделей с разным временем загрузки имеет смысл задавать interval per-model.

## Типовые проблемы и диагностика

- Сервер не стартует: проверьте, не задано ли `0`; ошибка будет `cannot be 0 or less than -1`.
- Первый запрос после простоя стал медленным: это ожидаемый wake/reload.
- Мониторинг не будит модель: `GET /health`, `GET /props`, `GET /models` специально исключены.
- Модель не выходит из sleep: ищите логи `requesting to stop sleeping`, `exiting sleeping state`, `server is exiting sleeping state`, затем ошибки повторного `load_model`.

## Примеры

```bash
llama-server --model /models/model.gguf --sleep-idle-seconds 300
```

```bash
llama-server --model /models/model.gguf --sleep-idle-seconds -1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-queue.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-models.cpp`
- `llama.cpp/tools/server/README.md`
