---
schema: 1
primaryName: "--dry-penalty-last-n"
title: "--dry-penalty-last-n"
summary: "Ограничивает, сколько последних токенов DRY сканирует в поиске повторов. По умолчанию `-1` — окно равно размеру контекста; `0` отключает DRY penalty по истории."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--dry-penalty-last-n"
allowedValues: []
env: []
related:
  - "--dry-multiplier"
  - "--dry-base"
  - "--dry-allowed-length"
  - "--dry-sequence-breaker"
  - "--ctx-size"
  - "--parallel"
---

# --dry-penalty-last-n

## Кратко

`--dry-penalty-last-n` задает окно истории для DRY sampler. Это отдельное окно, независимое от `--repeat-last-n`.

Default в `common.h`: `-1` — окно равно размеру контекста, т.е. по умолчанию DRY сканирует всю доступную историю. `0` отключает penalty, значения меньше `-1` отклоняются.

## Оригинальная справка llama.cpp

```text
set DRY penalty for the last n tokens (default: -1, 0 = disable, -1 = context size)
```

## Паспорт аргумента

- Основное имя: `--dry-penalty-last-n`
- Алиасы: `--dry-penalty-last-n`
- Тип CLI-значения: целое число `N`
- Поле в `common_params_sampling`: `dry_penalty_last_n`
- HTTP-поле: `dry_penalty_last_n`
- Значение по умолчанию: `-1` (размер контекста)
- Проверка CLI: значение меньше `-1` отклоняется как `invalid dry-penalty-last-n`.
- Проверка HTTP task: `tools/server/server-schema.cpp` задает hard limits `-1..INT32_MAX`; значение вне диапазона отклоняется с ошибкой `Value must be between -1 <= value <= 2147483647`.

## Что меняет в llama-server

Значение передается в `llama_sampler_init_dry` как количество последних токенов, где DRY ищет повторяющиеся последовательности. Сервер в post-processing запроса разворачивает `-1` в размер контекста слота (`n_ctx_slot`, `tools/server/server-schema.cpp`); внутри сэмплера `-1` дополнительно трактуется как полный размер контекста, а окно всегда ограничено сверху размером контекста.

Если `--dry-multiplier 0`, окно не дает практического эффекта.

## Значения и формат

- `-1`: default — сканировать весь контекст слота.
- `0`: отключить DRY penalty по истории.
- Положительное число: сканировать не больше указанного числа последних токенов.
- Меньше `-1`: ошибка.

## Когда использовать

Default `-1` ловит повторы по всей истории — это максимально агрессивный и самый дорогой режим. Задавайте явное положительное окно (обычно несколько сотен — пара тысяч токенов), если sampling overhead заметен на большом `--ctx-size` или DRY слишком сильно связывает разные части диалога.

Для коротких completion endpoint задач часто достаточно нескольких сотен токенов.

## Влияние на производительность и память

Параметр не меняет KV-cache, но прямо влияет на CPU work DRY sampler. Большое окно — в том числе default `-1` при большом `--ctx-size` — может заметно увеличить sampling latency на токен.

## Взаимодействие с другими аргументами

- `--dry-multiplier`: включает DRY; при `0` окно не важно.
- `--ctx-size` и `--parallel`: при default `-1` определяют фактическое окно — сервер разворачивает его в контекст слота.
- `--dry-sequence-breaker`: влияет на то, какие последовательности считаются продолжением повтора внутри окна.
- `--repeat-last-n`: отдельное окно для обычного `penalties` sampler, не заменяет DRY window.

## INI-пресеты и router-режим

Аргумент разрешен в `--models-preset`:

```ini
[model.default]
dry-multiplier = 0.8
dry-penalty-last-n = 512
```

HTTP-запрос может переопределить его через `dry_penalty_last_n`.

## Типовые проблемы и диагностика

- Ошибка `Value must be between -1 <= value <= ...`: клиент или preset передал значение меньше `-1`.
- Высокая sampling latency на большом контексте: замените default `-1` на явное окно поменьше.
- DRY не ловит длинные повторы: проверьте, не задано ли маленькое явное окно.

Смотрите `sampler params`: там печатается уже фактическое `dry_penalty_last_n` после замены `-1`.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-penalty-last-n 512
```

```bash
llama-server --model /models/model.gguf --ctx-size 8192 --dry-multiplier 0.8 --dry-penalty-last-n 2048
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление и CLI-проверка `--dry-penalty-last-n`.
- `llama.cpp/common/common.h`: default `dry_penalty_last_n = -1`.
- `llama.cpp/common/sampling.cpp`: вызов `llama_sampler_init_dry`.
- `llama.cpp/src/llama-sampler.cpp`: раскрытие `-1` в полный размер контекста внутри DRY apply.
- `llama.cpp/tools/server/server-schema.cpp`: JSON-поле, hard limits `-1..INT32_MAX` и разворачивание `-1` в `n_ctx_slot`.
- `llama.cpp/tools/server/README.md`: описание request-параметра.
