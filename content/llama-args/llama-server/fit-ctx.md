---
schema: 1
primaryName: "--fit-ctx"
title: "--fit-ctx"
summary: "Задает минимальный context size, до которого `--fit` может снизить автоматически выбранный контекст. По умолчанию минимум равен `4096`."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-fitc"
  - "--fit-ctx"
allowedValues: []
env:
  - "LLAMA_ARG_FIT_CTX"
related:
  - "--ctx-size"
  - "--fit"
  - "--fit-target"
  - "--parallel"
---

# --fit-ctx

## Кратко

`--fit-ctx` задает нижнюю границу context size, которую fit-to-memory может выбрать при нехватке памяти. Дефолт - `4096`.

Аргумент не задает рабочий context напрямую; для этого используется `--ctx-size`. Он только ограничивает автоматическое уменьшение context во время `--fit on`.

## Оригинальная справка llama.cpp

```text
minimum ctx size that can be set by --fit option, default: 4096
```

## Паспорт аргумента

- Основное имя: `--fit-ctx`
- Алиасы: `-fitc`, `--fit-ctx`
- Переменная окружения: `LLAMA_ARG_FIT_CTX`
- Поле `common_params`: `fit_params_min_ctx`
- Значение по умолчанию: `4096`
- Этап применения: только внутри `common_fit_params()`

## Что меняет в llama-server

Парсер записывает целое число в `fit_params_min_ctx`. В fit-step этот минимум используется, когда текущий context равен `0`, то есть должен быть взят из model metadata.

Если пользователь явно задал `--ctx-size` не равным `0`, fit не уменьшает context. Если пользователь явно задал `--ctx-size 0`, обработчик `--ctx-size` устанавливает `fit_params_min_ctx = UINT32_MAX`, чтобы запретить reduction полного model context.

## Значения и формат

Значение - целое число токенов. Отрицательные значения парсером явно не запрещены, но они не имеют практического смысла для context size и не должны использоваться в конфигурации.

## Когда использовать

Увеличивайте `--fit-ctx`, если минимально приемлемый context для сервера выше дефолтных `4096`. Уменьшайте только для тестовых запусков маленьких моделей или когда важнее стартовать, чем держать длинный контекст.

## Влияние на производительность и память

Меньший context снижает память KV-cache и compute requirements, но ограничивает длину запросов и историю диалога. Больший минимум может заставить fit перенести меньше слоев на GPU или не подобрать конфигурацию.

## Взаимодействие с другими аргументами

Работает только с `--fit on` и только когда `--ctx-size` не зафиксирован пользователем.

`--parallel` увеличивает потребности KV-cache, поэтому при большом числе слотов fit может сильнее давить на context или offload.

`--fit-target` задает, насколько агрессивно fit пытается оставлять память свободной.

## INI-пресеты и router-режим

В INI:

```ini
fit = on
fit-ctx = 8192
```

В router-режиме это модельный параметр. Для моделей с разной ожидаемой длиной prompt лучше задавать в отдельных секциях.

## Типовые проблемы и диагностика

- Context оказался меньше ожидаемого: проверьте, не оставлен ли `--ctx-size` в auto-режиме и не сработал ли fit.
- Fit не снижает context: пользовательский `--ctx-size` блокирует reduction.
- Модель не помещается даже после reduction: уменьшите `--fit-ctx`, увеличьте `--fit-target` осторожно или снизьте `--gpu-layers`.

## Примеры

```bash
llama-server --model /models/model.gguf --fit on --fit-ctx 4096
```

```bash
llama-server --model /models/model.gguf --fit on --fit-ctx 8192 --fit-target 2048
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/tools/server/README.md`
