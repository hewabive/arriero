---
schema: 1
primaryName: "--adaptive-decay"
title: "--adaptive-decay"
summary: "EMA decay для `adaptive_p`: меньшие значения быстрее реагируют на последние выбранные токены, большие дают более стабильную историю. В реализации значение clamp-ится в диапазон `0.0..0.99`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--adaptive-decay"
allowedValues: []
env: []
related:
  - "--adaptive-target"
  - "--samplers"
  - "--seed"
---

# --adaptive-decay

## Кратко

`--adaptive-decay` задает скорость забывания истории в `adaptive_p`. История хранится как экспоненциальное среднее вероятностей выбранных токенов: меньше decay - быстрее реакция, больше decay - плавнее поведение.

## Оригинальная справка llama.cpp

```text
adaptive-p: decay rate for target adaptation over time. lower values are more reactive, higher values are more stable. (valid range 0.0 to 0.99) (default: 0.90)
```

## Паспорт аргумента

- Основное имя: `--adaptive-decay`
- Поле в `common_params`: `params.sampling.adaptive_decay`
- HTTP-поле: `adaptive_decay`
- Значение по умолчанию: `0.90`
- Реальный диапазон в sampler init: clamp к `0.0..0.99`.

## Что меняет в llama-server

CLI-парсер записывает float. Значение используется только при наличии `adaptive_p` в sampler-цепочке. В `llama_sampler_init_adaptive_p` decay clamp-ится, затем используется для начального EMA и обновляется после accepted token.

## Значения и формат

- `0.90` - дефолт; эффективная история примерно `1 / (1 - decay)`, то есть около 10 токенов.
- `0.0` - почти без памяти, реакция только на текущий шаг.
- `0.99` - длинная история около 100 токенов.
- `< 0` становится `0.0`, `> 0.99` становится `0.99` в реализации.

## Когда использовать

- Уменьшайте, если adaptive sampler слишком медленно реагирует на смену контекста.
- Увеличивайте, если ответы скачут по стилю или вероятности выбора нестабильны.
- Подбирайте вместе с `--adaptive-target`; отдельно decay не включает adaptive sampling.

## Влияние на производительность и память

Память модели не меняется. Параметр влияет на небольшое per-slot состояние adaptive sampler-а. Backend support для `adaptive_p` отсутствует.

## Взаимодействие с другими аргументами

- Без `--adaptive-target >= 0` adaptive transform не включается, даже если sampler `adaptive_p` есть в цепочке.
- Без `adaptive_p` в `--samplers` или `a` в `--sampler-seq` параметр не используется.
- `--seed` влияет на RNG adaptive sampler-а.

## INI-пресеты и router-режим

Ключ INI:

```ini
[adaptive]
adaptive-decay = 0.95
```

HTTP-поле: `"adaptive_decay"`.

## Типовые проблемы и диагностика

- Decay меняется, но ответы не меняются: adaptive sampler не включен.
- Слишком резкая реакция: decay слишком низкий.
- Слишком инертное поведение: decay слишком близок к `0.99`.

## Примеры

```bash
llama-server --model /models/model.gguf --sampler-seq kpmta --adaptive-target 0.2 --adaptive-decay 0.95
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-task.cpp`
