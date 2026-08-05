---
schema: 1
primaryName: "--rope-freq-scale"
title: "--rope-freq-scale"
summary: "Задает внутренний RoPE frequency scale напрямую: контекст расширяется примерно в `1/N` раз. Это низкоуровневая форма того же поля, которое `--rope-scale` задает как обратный коэффициент."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--rope-freq-scale"
allowedValues: []
env:
  - "LLAMA_ARG_ROPE_FREQ_SCALE"
related:
  - "--ctx-size"
  - "--rope-scaling"
  - "--rope-scale"
  - "--yarn-attn-factor"
---

# --rope-freq-scale

## Кратко

`--rope-freq-scale N` записывает `N` напрямую в `common_params::rope_freq_scale`. В отличие от `--rope-scale`, здесь нет автоматического обращения: `--rope-freq-scale 0.25` соответствует `--rope-scale 4`.

Используйте этот аргумент, когда рецепт модели или существующий запуск уже говорит именно о `freq_scale`.

## Оригинальная справка llama.cpp

```text
RoPE frequency scaling factor, expands context by a factor of 1/N
```

## Паспорт аргумента

- Основное имя: `--rope-freq-scale`
- Алиасы: `--rope-freq-scale`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_ROPE_FREQ_SCALE`
- Поле в `common_params`: `rope_freq_scale`
- Этап применения: парсинг CLI/env, затем создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` значение записывается напрямую. В `src/llama-context.cpp`, если итоговый `rope_freq_scale == 0.0f`, используется `hparams.rope_freq_scale_train` из модели; иначе берется заданное значение.

В `src/llama-model.cpp` scale из metadata хранится как обратный коэффициент: GGUF factor `ropescale` превращается в `hparams.rope_freq_scale_train = 1.0f / ropescale`, если factor не равен нулю.

## Значения и формат

- `1` означает отсутствие расширения частотной шкалы.
- `0.5` означает примерно 2-кратное расширение.
- `0.25` означает примерно 4-кратное расширение.
- `0` оставляет значение модели, потому что контекст заменяет ноль на `rope_freq_scale_train`.
- Отрицательные значения не запрещены парсером, но не являются нормальной настройкой для эксплуатации.

## Когда использовать

- При переносе конфигураций, где уже указан `freq_scale`.
- Для точной сверки с логами `llama_new_context_with_model: freq_scale = ...`.
- Когда нужно избежать двусмысленности обратного преобразования `--rope-scale`.

## Влияние на производительность и память

Как и другие RoPE-параметры, `--rope-freq-scale` почти не меняет память сам по себе. Память определяют `--ctx-size`, `--parallel`, KV-cache и offload. Основной риск - качество генерации на длинных позициях.

## Взаимодействие с другими аргументами

- `--rope-scale` и `--rope-freq-scale` конфликтуют, потому что пишут одно поле. Не держите оба в постоянном preset.
- `--rope-scaling none` сбрасывает итоговый `freq_scale` в `1.0`.
- Для YaRN значение участвует в вычислении `factor = 1.0f / rope_freq_scale` и автоматической коррекции `yarn_attn_factor`, если YaRN включен и attention factor не задан явно.
- `--ctx-size` должен быть увеличен отдельно.

## INI-пресеты и router-режим

```ini
[my-model]
ctx-size = 32768
rope-scaling = linear
rope-freq-scale = 0.25
```

В router mode параметр можно задавать в model preset. CLI router-а имеет больший приоритет, поэтому глобальный `--rope-freq-scale` может перекрыть per-model настройку.

## Типовые проблемы и диагностика

- Перепутан scale и factor: если нужен 4x context, обычно требуется `--rope-freq-scale 0.25`, а не `4`.
- Значение не изменилось: проверьте, не задан ли позже `--rope-scale` или `LLAMA_ARG_ROPE_SCALE`.
- Логи показывают `freq_scale = 1`: проверьте `--rope-scaling none`, потому что он принудительно отключает scaling.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling linear --rope-freq-scale 0.25
```

```bash
LLAMA_ARG_ROPE_FREQ_SCALE=0.5 llama-server --model /models/model.gguf --ctx-size 16384
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
