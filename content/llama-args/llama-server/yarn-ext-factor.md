---
schema: 1
primaryName: "--yarn-ext-factor"
title: "--yarn-ext-factor"
summary: "Настраивает YaRN extrapolation mix factor. Значение по умолчанию `-1` означает auto: для `--rope-scaling yarn` llama.cpp использует `1.0`, для остальных режимов `0.0`."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--yarn-ext-factor"
allowedValues: []
env:
  - "LLAMA_ARG_YARN_EXT_FACTOR"
related:
  - "--rope-scaling"
  - "--rope-scale"
  - "--rope-freq-scale"
  - "--yarn-attn-factor"
  - "--yarn-orig-ctx"
---

# --yarn-ext-factor

## Кратко

`--yarn-ext-factor` управляет долей YaRN extrapolation. Это float-параметр, который передается в `llama_context_params::yarn_ext_factor`.

Значение `-1` в defaults не является рабочим коэффициентом, а означает "не задано". При создании контекста llama.cpp заменяет его на `1.0`, если выбран `--rope-scaling yarn`, и на `0.0` для остальных типов scaling.

## Оригинальная справка llama.cpp

```text
YaRN: extrapolation mix factor (default: -1.00, 0.0 = full interpolation)
```

## Паспорт аргумента

- Основное имя: `--yarn-ext-factor`
- Алиасы: `--yarn-ext-factor`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_YARN_EXT_FACTOR`
- Поле в `common_params`: `yarn_ext_factor`
- Этап применения: создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` значение записывается в `params.yarn_ext_factor`. В `src/llama-context.cpp` отрицательное значение трактуется как unset. Если после этого `yarn_ext_factor != 0`, контекст выполняет YaRN-ветку расчета attention magnitude и может автоматически вычислить `yarn_attn_factor`.

При `0.0` YaRN extrapolation отключается в этой ветке: справка описывает это как full interpolation.

## Значения и формат

- `-1`: auto/unset, default llama.cpp.
- `0.0`: full interpolation.
- `1.0`: обычная полная extrapolation для `--rope-scaling yarn`.
- Другие float-значения используйте только по проверенному рецепту модели.

## Когда использовать

- Когда long-context рецепт модели явно указывает YaRN ext factor.
- Когда нужно отключить YaRN extrapolation, оставив другие параметры для сравнения: `--yarn-ext-factor 0`.
- Когда metadata модели неполные, но известна корректная YaRN-конфигурация.

## Влияние на производительность и память

Память почти не меняется. Влияние проявляется в качестве и устойчивости на длинных позициях. При `yarn_ext_factor != 0` в `llama-context.cpp` дополнительно пересчитывается attention factor, что видно в warning-логе `setting new yarn_attn_factor`.

## Взаимодействие с другими аргументами

- `--rope-scaling yarn` меняет auto-default `-1` на `1.0`.
- `--rope-scale` или `--rope-freq-scale` задают factor, от которого зависит автоматический расчет `yarn_attn_factor`.
- Явный `--yarn-attn-factor` может быть перезаписан в YaRN-ветке, если `yarn_ext_factor != 0`, потому что код пересчитывает `cparams.yarn_attn_factor`.
- `--yarn-orig-ctx` задает исходную длину контекста для YaRN.

## INI-пресеты и router-режим

```ini
[my-yarn-model]
rope-scaling = yarn
rope-scale = 4
yarn-ext-factor = 1
```

В router mode параметр может быть per-model настройкой в `--models-preset`.

## Типовые проблемы и диагностика

- `--rope-scaling yarn` задан, но поведение похоже на interpolation: проверьте, не стоит ли `yarn-ext-factor = 0`.
- В логах появляется `setting new yarn_attn_factor`: это ожидаемо при `yarn_ext_factor != 0`.
- Нестабильное качество на длинном контексте: сравните `0`, `1` и default `-1` только при фиксированных `--ctx-size` и `--rope-scale`.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-ext-factor 1
```

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-ext-factor 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
