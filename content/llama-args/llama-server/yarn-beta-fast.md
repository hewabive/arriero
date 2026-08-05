---
schema: 1
primaryName: "--yarn-beta-fast"
title: "--yarn-beta-fast"
summary: "Задает YaRN low correction dim, также называемый beta. Значение `-1` оставляет параметр из metadata модели."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--yarn-beta-fast"
allowedValues: []
env:
  - "LLAMA_ARG_YARN_BETA_FAST"
related:
  - "--rope-scaling"
  - "--yarn-beta-slow"
  - "--yarn-ext-factor"
  - "--yarn-orig-ctx"
---

# --yarn-beta-fast

## Кратко

`--yarn-beta-fast` задает YaRN low correction dim, который help также называет `beta`. Это парный параметр к `--yarn-beta-slow`.

Default `-1.0f` означает "не задавать вручную". При создании контекста llama.cpp берет значение из hparams модели, если CLI/env не дал неотрицательное число.

## Оригинальная справка llama.cpp

```text
YaRN: low correction dim or beta (default: -1.00)
```

## Паспорт аргумента

- Основное имя: `--yarn-beta-fast`
- Алиасы: `--yarn-beta-fast`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_YARN_BETA_FAST`
- Поле в `common_params`: `yarn_beta_fast`
- Этап применения: создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` значение записывается в `params.yarn_beta_fast`. В `src/llama-context.cpp` значение `>= 0.0f` используется как явное, а отрицательное заменяется на `hparams.yarn_beta_fast`.

## Значения и формат

- `-1`: auto/unset, default llama.cpp.
- `0` и положительные числа: ручная настройка low correction dim/beta.
- Для читаемости конфигурации используйте `-1`, если хотите именно default из модели, а не произвольное отрицательное число.

## Когда использовать

- Когда YaRN recipe модели явно задает beta-fast/beta.
- Когда нужно воспроизвести чужой запуск или сравнить metadata модели с исходной конфигурацией.
- При точечной настройке long-context качества вместе с `--yarn-beta-slow`.

## Влияние на производительность и память

Память, VRAM и throughput почти не меняются напрямую. Ошибочное значение проявляется как качество: потеря дальнего контекста, повторы, нестабильные ответы на длинных prompts.

## Взаимодействие с другими аргументами

- Обычно задается вместе с `--yarn-beta-slow`.
- Имеет смысл главным образом при `--rope-scaling yarn`.
- `--rope-scale` или `--rope-freq-scale` задают общий масштаб, а beta-параметры уточняют correction dims.
- `--yarn-orig-ctx` должен соответствовать исходному контексту модели.

## INI-пресеты и router-режим

```ini
[my-yarn-model]
rope-scaling = yarn
rope-scale = 4
yarn-beta-fast = 1
yarn-beta-slow = 32
```

В router mode параметр применим как обычная per-model настройка `--models-preset`.

## Типовые проблемы и диагностика

- Значение взято из случайного recipe другой модели: верните `-1`; beta-параметры плохо переносятся между архитектурами.
- Long-context качество нестабильно: проверяйте пару `--yarn-beta-fast` и `--yarn-beta-slow`, а не один параметр отдельно.
- Сверяйте логи RoPE/YaRN и фактический `--ctx-size`; beta-параметры не увеличивают контекст сами.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-beta-fast 1 --yarn-beta-slow 32
```

```bash
llama-server --model /models/model.gguf --rope-scaling yarn --yarn-beta-fast -1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
