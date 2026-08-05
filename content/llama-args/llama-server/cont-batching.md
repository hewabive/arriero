---
schema: 1
primaryName: "--cont-batching"
title: "--cont-batching"
summary: "Включает continuous batching: новые задачи могут добавляться в batch на лету, пока сервер уже обрабатывает другие слоты. По умолчанию включено."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "-cb"
  - "--cont-batching"
  - "-nocb"
  - "--no-cont-batching"
allowedValues: []
env:
  - "LLAMA_ARG_CONT_BATCHING"
related:
  - "--batch-size"
  - "--ubatch-size"
  - "--parallel"
  - "--threads-batch"
---

# --cont-batching

## Кратко

`--cont-batching` управляет `common_params::cont_batching`. Когда включено, `update_slots()` может подмешивать prompt tokens новых задач в batch, пока другие слоты уже генерируют или обрабатывают prompt.

Это флаг-переключатель: включение `--cont-batching`, отключение `--no-cont-batching` или `-nocb`.

## Оригинальная справка llama.cpp

```text
whether to enable continuous batching (a.k.a dynamic batching) (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--cont-batching`
- Алиасы включения: `-cb`, `--cont-batching`
- Алиасы выключения: `-nocb`, `--no-cont-batching`
- Значение по умолчанию: enabled
- Переменная окружения: `LLAMA_ARG_CONT_BATCHING`
- Поле llama.cpp: `common_params::cont_batching`
- Этап применения: runtime scheduler loop в `server-context.cpp`

## Что меняет в llama-server

В scheduler loop новые prompts добавляются, если `params_base.cont_batching || batch.n_tokens == 0`. Поэтому при отключении continuous batching сервер все еще может начать prompt, когда текущий batch пуст, но не будет так агрессивно смешивать новую работу с уже активным batch.

Слоты батчатся вместе только если совместимы по типу задачи и LoRA-состоянию (`can_batch_with`).

## Значения и формат

CLI-форма не принимает отдельное значение:

- `--cont-batching`: включить.
- `--no-cont-batching`: выключить.
- В INI boolean значения разбираются через truthy/falsey; для отрицательного ключа значение инвертируется.

## Когда использовать

Оставляйте включенным для API-сервера и нескольких слотов: это основной путь к хорошему throughput.

Отключайте для диагностики latency, воспроизводимости проблем batch scheduler или если важнее предсказуемость одиночного запроса, чем суммарная пропускная способность.

## Влияние на производительность и память

Включение повышает utilization backend и throughput при конкурентных запросах. Цена: отдельный запрос может получать более вариативную latency, потому что batch формируется динамически.

Память напрямую не увеличивается как отдельный буфер, но continuous batching повышает шанс одновременно держать больше активных prompt/generation состояний в KV.

## Взаимодействие с другими аргументами

- `--parallel`: без нескольких слотов эффект ограничен.
- `--batch-size`: верхний лимит токенов, которые scheduler может собрать.
- `--ubatch-size`: физический размер micro-batch после логического batching.
- `--threads-batch`: CPU-потоки для prompt/batch phase.
- `--cache-prompt`: reused prefix уменьшает объем токенов, попадающих в batch.

## INI-пресеты и router-режим

В INI используйте `cont-batching = true` или `no-cont-batching = true`. Ключ `LLAMA_ARG_CONT_BATCHING` также распознается.

В router-режиме применяется в дочернем процессе конкретной модели.

## Типовые проблемы и диагностика

- Включите verbose/trace logging, чтобы видеть `decoding batch, n_tokens = ...` и переходы slot state.
- Если маленькие запросы имеют нестабильную latency под нагрузкой, сравните запуск с `--no-cont-batching`.
- Если batch часто пустой и есть `no tokens to decode`, проблема обычно не в этом флаге, а в состоянии очереди/слотов.

## Примеры

```bash
llama-server --model /models/model.gguf --parallel 4 --cont-batching
```

```bash
llama-server --model /models/model.gguf --parallel 1 --no-cont-batching
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
