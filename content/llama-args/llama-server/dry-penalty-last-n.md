---
schema: 1
primaryName: "--dry-penalty-last-n"
title: "--dry-penalty-last-n"
summary: "Ограничивает, сколько последних токенов DRY сканирует в поиске повторов. По умолчанию окно равно `64`, `0` отключает DRY penalty по истории, отрицательные значения не принимаются."
category: "Параметры сэмплинга"
valueType: "number"
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

Default в `common.h`: `64`. В актуальном llama.cpp прежнее специальное значение `-1` удалено и отклоняется как на CLI, так и в HTTP-запросе.

## Оригинальная справка llama.cpp

```text
set DRY penalty for the last n tokens (default: 64, 0 = disable)
```

## Паспорт аргумента

- Основное имя: `--dry-penalty-last-n`
- Алиасы: `--dry-penalty-last-n`
- Тип CLI-значения: целое число `N`
- Поле в `common_params_sampling`: `dry_penalty_last_n`
- HTTP-поле: `dry_penalty_last_n`
- Значение по умолчанию: `64`
- Проверка CLI: значение меньше `0` отклоняется.
- Проверка HTTP task: значение меньше `0` отклоняется как `Error: dry_penalty_last_n must be >= 0`.

## Что меняет в llama-server

Значение передается в `llama_sampler_init_dry` как количество последних токенов, где DRY ищет повторяющиеся последовательности.

Если `--dry-multiplier 0`, окно не дает практического эффекта.

## Значения и формат

- `0`: отключить DRY penalty по истории.
- Положительное число: сканировать не больше указанного числа последних токенов.
- Отрицательное число: ошибка.

## Когда использовать

Оставляйте `64` как небольшой bounded baseline. Увеличивайте окно явно, если цель — ловить более длинные повторы; уменьшайте, если sampling overhead заметен или DRY слишком сильно связывает разные части диалога.

Для коротких completion endpoint задач часто достаточно нескольких сотен токенов.

## Влияние на производительность и память

Параметр не меняет KV-cache, но прямо влияет на CPU work DRY sampler. Большое окно, особенно `-1` при большом `--ctx-size`, может увеличить sampling latency на токен.

## Взаимодействие с другими аргументами

- `--dry-multiplier`: включает DRY; при `0` окно не важно.
- `--ctx-size` и `--parallel` не меняют окно автоматически; при необходимости задайте нужное положительное значение явно.
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

- Ошибка `dry_penalty_last_n must be >= 0`: клиент или preset передал отрицательное значение.
- Высокая sampling latency: уменьшите `--dry-penalty-last-n`.
- DRY не ловит длинные повторы: увеличьте окно явно.

Смотрите `sampler params`: там печатается уже фактическое `dry_penalty_last_n` после замены `-1`.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-penalty-last-n 512
```

```bash
llama-server --model /models/model.gguf --ctx-size 8192 --dry-multiplier 0.8 --dry-penalty-last-n 8192
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление и CLI-проверка `--dry-penalty-last-n`.
- `llama.cpp/common/common.h`: default `dry_penalty_last_n = 64`.
- `llama.cpp/common/sampling.cpp`: `llama_sampler_init_dry`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле и проверка неотрицательного значения.
- `llama.cpp/tools/server/README.md`: описание request-параметра.
