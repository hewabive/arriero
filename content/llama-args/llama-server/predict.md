---
schema: 1
primaryName: "--predict"
title: "--predict"
summary: "Глобальный default максимального числа генерируемых токенов. `-1` означает без лимита, но запрос все равно ограничен EOS, stop words, `n_ctx` и context shift."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-n"
  - "--predict"
  - "--n-predict"
allowedValues: []
env:
  - "LLAMA_ARG_N_PREDICT"
related:
  - "--ctx-size"
  - "--context-shift"
  - "--keep"
  - "--ignore-eos"
---

# --predict

## Кратко

`--predict` задает `common_params::n_predict`: global default для максимального числа новых токенов. В `llama-server` каждый HTTP-запрос может переопределить его через `n_predict`, `max_tokens` или `max_completion_tokens`.

По умолчанию `-1`, то есть без лимита по этому параметру.

## Оригинальная справка llama.cpp

```text
number of tokens to predict (default: -1, -1 = infinity)
```

## Паспорт аргумента

- Основное имя: `--predict`
- Алиасы: `-n`, `--predict`, `--n-predict`
- Значение по умолчанию: `-1`
- Специальное значение: `-1` infinity
- Переменная окружения: `LLAMA_ARG_N_PREDICT`
- Поле llama.cpp: `common_params::n_predict`, затем `task_params::n_predict`
- Этап применения: budget check во время генерации

## Что меняет в llama-server

`server_task.cpp` кладет global default в request params. Затем `server_slot::has_budget()` сравнивает `n_decoded` с request/global limit. Когда лимит исчерпан, slot получает `STOP_TYPE_LIMIT`.

В README указано, что `n_predict = 0` в HTTP-запросе не генерирует tokens, но оценивает prompt в cache. Для CLI default это тоже просто числовой лимит, передаваемый в params.

## Значения и формат

- `-1`: без лимита по `n_predict`.
- `0`: не генерировать новые токены, полезно для прогрева/заполнения prompt cache через HTTP.
- Положительное число: максимум новых токенов.
- `-2` как "until context filled" описан только для completion example, не для server help в этом commit.

## Когда использовать

Для публичного или shared сервера задавайте конечное значение, например `--predict 512`, чтобы запросы без `max_tokens` не могли генерировать бесконечно. Для локального интерактивного сервера можно оставить `-1`, если есть stop words, EOS и понятный контроль клиента.

## Влияние на производительность и память

Сам лимит не меняет стартовую память. Он ограничивает длительность выполнения слота, нагрузку очереди и риск заполнить контекст. При `-1` без `--context-shift` генерация все равно остановится на `n_ctx`; с `--context-shift` может продолжаться долго.

## Взаимодействие с другими аргументами

- `--ctx-size`: ограничивает prompt+completion, если context shift выключен.
- `--context-shift`: позволяет продолжать после заполнения окна.
- `--keep`: влияет на то, что сохраняется при shift.
- `--ignore-eos`: может сделать `--predict -1` опаснее, потому что EOS не остановит генерацию.
- HTTP `max_tokens`, `max_completion_tokens`, `n_predict`: переопределяют CLI default для запроса.

## INI-пресеты и router-режим

В INI используйте `predict = 512`, `n-predict = 512` или `LLAMA_ARG_N_PREDICT`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- В ответе смотрите `stop`: `limit` означает остановку по лимиту tokens/context.
- Лог `stopped by limit, n_decoded = ..., n_predict = ...` показывает срабатывание budget.
- Если запросы слишком долгие, задайте CLI default и/или принудительные лимиты на gateway.

## Примеры

```bash
llama-server --model /models/model.gguf --predict 512
```

```bash
llama-server --model /models/model.gguf --predict -1 --context-shift --keep 128
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
