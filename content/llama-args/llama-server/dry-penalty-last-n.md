---
schema: 1
primaryName: "--dry-penalty-last-n"
title: "--dry-penalty-last-n"
summary: "Ограничивает, сколько последних токенов DRY сканирует в поиске повторов. По умолчанию `64`; `0` отключает DRY penalty по истории, отрицательные значения отклоняются."
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
  - "--repeat-last-n"
---

# --dry-penalty-last-n

## Кратко

`--dry-penalty-last-n` задает окно истории для DRY sampler. Это отдельное окно, независимое от `--repeat-last-n`.

Default в `common.h`: `64` — общий default для history-based сэмплеров. `0` отключает penalty, отрицательные значения отклоняются. Раньше default был `-1` («сканировать весь контекст»), но upstream PR #26524 убрал эту семантику: backend sampling инициализирует сэмплеры до создания `llama_context`, когда фактический размер контекста еще неизвестен.

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
- Проверка CLI: отрицательное значение отклоняется как `invalid dry-penalty-last-n`.
- Проверка HTTP task: `tools/server/server-schema.cpp` задает hard limits `0..INT32_MAX`; значение вне диапазона отклоняется с ошибкой `Value must be between 0 <= value <= 2147483647`.

## Что меняет в llama-server

Значение передается в `llama_sampler_init_dry` как количество последних токенов, где DRY ищет повторяющиеся последовательности; внутри сэмплера оно дополнительно ограничивается снизу нулем, а фактическое окно на каждом шаге — минимумом из заданного значения и уже накопленной истории. Никакого разворачивания `-1` в размер контекста больше нет.

Если `--dry-multiplier 0`, окно не дает практического эффекта.

## Значения и формат

- `64`: default — небольшое локальное окно поиска повторов.
- `0`: отключить DRY penalty по истории.
- Положительное число: сканировать не больше указанного числа последних токенов.
- Отрицательное число: ошибка. Режима «весь контекст» через `-1` больше нет; если нужно окно во всю историю, задайте явное значение порядка `--ctx-size`.

## Когда использовать

Default `64` ловит только близкие повторы. Увеличивайте окно до нескольких сотен — пары тысяч токенов, если модель зацикливается на фразах или абзацах на большем расстоянии; DRY с большим окном — основной инструмент против дальних повторов. Уменьшайте окно или оставляйте default, если sampling overhead заметен на большом `--ctx-size` или DRY слишком сильно связывает разные части диалога.

Для коротких completion endpoint задач default обычно достаточен.

## Влияние на производительность и память

Параметр не меняет KV-cache, но прямо влияет на CPU work DRY sampler. Большое явное окно при большом `--ctx-size` может заметно увеличить sampling latency на токен; default `64` дешев.

## Взаимодействие с другими аргументами

- `--dry-multiplier`: включает DRY; при `0` окно не важно.
- `--dry-sequence-breaker`: влияет на то, какие последовательности считаются продолжением повтора внутри окна.
- `--repeat-last-n`: отдельное окно для обычного `penalties` sampler, не заменяет DRY window.
- `--ctx-size`: не влияет на окно напрямую, но задает верхнюю границу полезных значений — истории больше контекста не бывает.

## INI-пресеты и router-режим

Аргумент разрешен в `--models-preset`:

```ini
[model.default]
dry-multiplier = 0.8
dry-penalty-last-n = 512
```

HTTP-запрос может переопределить его через `dry_penalty_last_n`.

## Типовые проблемы и диагностика

- Ошибка старта с `invalid dry-penalty-last-n`: передано отрицательное значение.
- Ошибка `Value must be between 0 <= value <= ...`: клиент или preset передал отрицательное значение. Типичный случай после обновления llama.cpp — конфигурация, которая привыкла явно отправлять `dry_penalty_last_n: -1`; замените на явное окно.
- DRY перестал ловить дальние повторы после обновления llama.cpp: раньше default `-1` сканировал весь контекст, теперь default — `64`. Верните прежнее поведение явным большим окном.
- Высокая sampling latency на большом контексте: уменьшите явное окно.

Смотрите `sampler params`: там печатается фактическое `dry_penalty_last_n`.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-penalty-last-n 512
```

```bash
llama-server --model /models/model.gguf --ctx-size 8192 --dry-multiplier 0.8 --dry-penalty-last-n 2048
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление и CLI-проверка `--dry-penalty-last-n`.
- `llama.cpp/common/common.h`: default `dry_penalty_last_n = 64`.
- `llama.cpp/common/sampling.cpp`: вызов `llama_sampler_init_dry`.
- `llama.cpp/src/llama-sampler.cpp`: ограничение значения снизу нулем и cap окна накопленной историей.
- `llama.cpp/tools/server/server-schema.cpp`: JSON-поле и hard limits `0..INT32_MAX`.
- https://github.com/ggml-org/llama.cpp/pull/26524: смена default с `-1` на `64` и удаление семантики «окно = контекст».
