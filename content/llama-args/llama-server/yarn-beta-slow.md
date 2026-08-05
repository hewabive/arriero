---
schema: 1
primaryName: "--yarn-beta-slow"
title: "--yarn-beta-slow"
summary: "Задает YaRN high correction dim, также называемый alpha. Значение `-1` оставляет параметр из metadata модели."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--yarn-beta-slow"
allowedValues: []
env:
  - "LLAMA_ARG_YARN_BETA_SLOW"
related:
  - "--rope-scaling"
  - "--yarn-beta-fast"
  - "--yarn-ext-factor"
  - "--yarn-orig-ctx"
---

# --yarn-beta-slow

## Кратко

`--yarn-beta-slow` задает YaRN high correction dim, который в help также назван `alpha`. Это один из тонких параметров формы YaRN scaling; менять его стоит только по рецепту модели или при целевой диагностике.

По умолчанию `common_params::yarn_beta_slow` равен `-1.0f`. При создании контекста отрицательное значение заменяется на `hparams.yarn_beta_slow` из модели.

## Оригинальная справка llama.cpp

```text
YaRN: high correction dim or alpha (default: -1.00)
```

## Паспорт аргумента

- Основное имя: `--yarn-beta-slow`
- Алиасы: `--yarn-beta-slow`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_YARN_BETA_SLOW`
- Поле в `common_params`: `yarn_beta_slow`
- Этап применения: создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` аргумент записывает float в `params.yarn_beta_slow`. В `common/common.cpp` значение копируется в `llama_context_params`. В `src/llama-context.cpp` правило простое: если значение `>= 0.0f`, используется CLI/env; если меньше нуля, используется значение из hparams модели.

## Значения и формат

- `-1`: auto/unset, default llama.cpp.
- `0` и положительные числа: явное значение high correction dim/alpha.
- Отрицательные значения кроме `-1` также попадают в ветку "из модели"; для читаемой конфигурации используйте именно `-1`.

## Когда использовать

- Когда модельная карточка или проверенный recipe указывает beta/alpha для YaRN.
- Когда GGUF metadata отсутствует или подозрительно отличается от исходной конфигурации модели.
- Для экспериментов качества на long context вместе с `--yarn-beta-fast`.

## Влияние на производительность и память

Память и скорость почти не меняются напрямую. Неверное значение меняет позиционную коррекцию и может испортить качество без ошибки запуска.

## Взаимодействие с другими аргументами

- Обычно настраивается парой с `--yarn-beta-fast`.
- Имеет смысл в конфигурациях с `--rope-scaling yarn`.
- `--yarn-ext-factor` и `--yarn-attn-factor` управляют другими частями YaRN и не заменяют beta-параметры.
- `--ctx-size`, `--rope-scale` и `--yarn-orig-ctx` определяют масштаб long-context сценария.

## INI-пресеты и router-режим

```ini
[my-yarn-model]
rope-scaling = yarn
rope-scale = 4
yarn-beta-slow = 32
yarn-beta-fast = 1
```

В router mode параметр можно задавать в per-model preset. Если он указан глобально в CLI router-а, дочерние модели унаследуют его.

## Типовые проблемы и диагностика

- Неясно, какое значение нужно: оставьте `-1` и доверьтесь metadata модели.
- Ручное значение ухудшило качество: верните `-1`, затем проверяйте `--rope-scale` и `--yarn-orig-ctx`.
- Для диагностики сверяйте логи `n_ctx_orig_yarn`, `freq_scale` и выбранный recipe модели.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-beta-slow 32 --yarn-beta-fast 1
```

```bash
llama-server --model /models/model.gguf --rope-scaling yarn --yarn-beta-slow -1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
