---
schema: 1
primaryName: "--adaptive-target"
title: "--adaptive-target"
summary: "Целевая вероятность для experimental `adaptive_p` sampler-а. Отрицательное значение отключает адаптацию; sampler начинает работать только если явно добавить `adaptive_p` в `--samplers` или `a` в `--sampler-seq`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--adaptive-target"
allowedValues: []
env: []
related:
  - "--adaptive-decay"
  - "--samplers"
  - "--sampler-seq"
  - "--seed"
---

# --adaptive-target

## Кратко

`--adaptive-target` задает вероятность, рядом с которой `adaptive_p` старается выбирать токены. Это не обычный фильтр: `adaptive_p` сам выбирает финальный токен и заменяет автоматический `dist`, если включен в sampler sequence.

## Оригинальная справка llama.cpp

```text
adaptive-p: select tokens near this probability (valid range 0.0 to 1.0; negative = disabled) (default: -1.00) [(more info)](https://github.com/ggml-org/llama.cpp/pull/17927)
```

## Паспорт аргумента

- Основное имя: `--adaptive-target`
- Поле в `common_params`: `params.sampling.adaptive_target`
- HTTP-поле: `adaptive_target`
- Значение по умолчанию: `-1.00`
- Отключение: отрицательное значение.

## Что меняет в llama-server

CLI-парсер только записывает float. Чтобы `adaptive_target` реально использовался, sampler-цепочка должна содержать `adaptive_p` (`--samplers`) или `a` (`--sampler-seq`). При обнаружении `adaptive_p` llama.cpp не вставляет обычный финальный `dist`, а добавляет `llama_sampler_init_adaptive_p(target, decay, seed)` в конец цепочки.

Если target отрицательный, `adaptive_p` становится близок к обычному sampling from distribution: он делает softmax и выбирает токен своим RNG без adaptive transform.

## Значения и формат

- `-1` - дефолт, адаптация отключена.
- `0.0`-`1.0` - документированный диапазон.
- Значения вне диапазона CLI принимает; implementation clamp-ит target в `[0, 1]` во время transform, кроме отрицательных значений, которые считаются no-op.

## Когда использовать

- Для исследовательских экспериментов с распределением выбора токенов.
- Когда нужно явно заменить финальный `dist` на adaptive sampler.
- Не включайте незаметно в публичном сервере: эффект существенно меняет стиль и пока помечен в help как дополнительная/экспериментальная логика через PR.

## Влияние на производительность и память

Память модели не меняется. Sampler хранит EMA-состояние и массив исходных probabilities для текущих кандидатов; это небольшая per-slot память. Backend hooks для `adaptive_p` отсутствуют, поэтому активный `adaptive_p` ограничивает пользу `--backend-sampling`.

## Взаимодействие с другими аргументами

- `--adaptive-decay` управляет EMA истории выбранных вероятностей.
- `--seed` инициализирует RNG adaptive sampler-а.
- `adaptive_p` должен быть последним по смыслу: код все равно добавляет его в конец после обхода `params.samplers`.
- Фильтры до него (`top_k`, `top_p`, `min_p`) формируют распределение, которое adaptive sampler трансформирует.

## INI-пресеты и router-режим

Ключ INI:

```ini
[adaptive]
samplers = penalties;dry;top_k;top_p;min_p;temperature;adaptive_p
adaptive-target = 0.2
```

HTTP API принимает `"adaptive_target"` и `"samplers": ["top_k", "top_p", "temperature", "adaptive_p"]`.

## Типовые проблемы и диагностика

- Задали `--adaptive-target`, но эффекта нет: в цепочке нет `adaptive_p`/`a`.
- Ответы перестали быть воспроизводимыми: target активен, но `--seed -1` оставляет случайный seed.
- В trace `sampler chain` должен показывать `adaptive-p`; обычного `dist` при этом быть не должно.

## Примеры

```bash
llama-server --model /models/model.gguf --samplers "top_k;top_p;min_p;temperature;adaptive_p" --adaptive-target 0.2 --adaptive-decay 0.9 --seed 42
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/include/llama.h`
- `llama.cpp/tools/server/server-task.cpp`
