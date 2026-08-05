---
schema: 1
primaryName: "--yarn-orig-ctx"
title: "--yarn-orig-ctx"
summary: "Задает исходную длину контекста, от которой YaRN считает растяжение. Значение `0` оставляет metadata модели, а если metadata нет, используется обучающий `n_ctx_train`."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--yarn-orig-ctx"
allowedValues: []
env:
  - "LLAMA_ARG_YARN_ORIG_CTX"
related:
  - "--ctx-size"
  - "--rope-scaling"
  - "--rope-scale"
  - "--yarn-ext-factor"
  - "--yarn-attn-factor"
---

# --yarn-orig-ctx

## Кратко

`--yarn-orig-ctx` задает исходную длину контекста модели для YaRN scaling. Это не размер runtime-контекста сервера: runtime-окно задается `--ctx-size`.

Значение нужно, чтобы llama.cpp понимал, от какого обучающего контекста считать растяжение. По умолчанию `0` означает "взять из модели"; если в модели нет отдельного YaRN metadata, используется `n_ctx_train`.

## Оригинальная справка llama.cpp

```text
YaRN: original context size of model (default: 0 = model training context size)
```

## Паспорт аргумента

- Основное имя: `--yarn-orig-ctx`
- Алиасы: `--yarn-orig-ctx`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: целое число
- Переменная окружения: `LLAMA_ARG_YARN_ORIG_CTX`
- Поле в `common_params`: `yarn_orig_ctx`
- Этап применения: парсинг CLI/env, затем создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` значение записывается в `common_params::yarn_orig_ctx`. В `common/common.cpp` оно копируется в `llama_context_params::yarn_orig_ctx`. В `src/llama-context.cpp` выбирается фактическое `n_ctx_orig_yarn`:

- если `--yarn-orig-ctx` не равен `0`, используется он;
- иначе, если модель содержит `hparams.n_ctx_orig_yarn`, используется metadata;
- иначе используется `hparams.n_ctx_train`.

## Значения и формат

- `0`: оставить исходный контекст из metadata или training context.
- Положительное целое: явно задать исходный контекст, например `4096` или `8192`.
- Отрицательные значения парсером специально не запрещены, но для этого поля они не имеют эксплуатационного смысла и могут привести к некорректной конфигурации.

## Когда использовать

- Когда модель была обучена или дообучена с известным исходным контекстом, но GGUF metadata неполные.
- Когда рецепт YaRN явно указывает original context length.
- При диагностике, если логи модели показывают подозрительный `n_ctx_orig_yarn`.

## Влияние на производительность и память

`--yarn-orig-ctx` не выделяет память напрямую. Память определяет `--ctx-size` и KV-cache. Неверный original context меняет позиционную математику и может ухудшить качество, особенно в середине и конце длинного промпта.

## Взаимодействие с другими аргументами

- `--ctx-size` должен быть больше исходного контекста, если вы действительно используете long context.
- `--rope-scaling yarn` делает YaRN-параметры практически значимыми.
- `--rope-scale` или `--rope-freq-scale` задают коэффициент растяжения; `--yarn-orig-ctx` задает базу, от которой это растяжение интерпретируется.
- `--yarn-ext-factor`, `--yarn-attn-factor`, `--yarn-beta-fast` и `--yarn-beta-slow` настраивают остальные части YaRN.

## INI-пресеты и router-режим

```ini
[my-yarn-model]
ctx-size = 32768
rope-scaling = yarn
rope-scale = 4
yarn-orig-ctx = 8192
```

В router mode этот ключ можно задавать в `--models-preset`; он будет применен дочерним процессом модели при создании контекста.

## Типовые проблемы и диагностика

- Перепутаны `--ctx-size` и `--yarn-orig-ctx`: первый задает runtime окно, второй - исходную длину для формулы YaRN.
- Качество хуже на long context: проверьте, совпадает ли `yarn-orig-ctx` с training/original context модели.
- В логах ищите `n_ctx_orig_yarn`, `freq_scale`, `rope scaling` и `n_ctx`.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-orig-ctx 8192
```

```bash
llama-server --model /models/model.gguf --rope-scaling yarn --yarn-orig-ctx 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
