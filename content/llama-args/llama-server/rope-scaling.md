---
schema: 1
primaryName: "--rope-scaling"
title: "--rope-scaling"
summary: "Выбирает алгоритм масштабирования RoPE при создании контекста: `none`, `linear` или `yarn`. Если аргумент не задан, llama.cpp берет тип из метаданных GGUF, а при отсутствии ключа модель считается `linear`."
category: "Общие параметры"
valueType: "enum"
valueHint: "{none,linear,yarn}"
aliases:
  - "--rope-scaling"
allowedValues:
  - "none"
  - "linear"
  - "yarn"
env:
  - "LLAMA_ARG_ROPE_SCALING_TYPE"
related:
  - "--ctx-size"
  - "--rope-scale"
  - "--rope-freq-scale"
  - "--yarn-ext-factor"
  - "--yarn-orig-ctx"
---

# --rope-scaling

## Кратко

`--rope-scaling` задает тип RoPE scaling, который `llama-server` передает в `llama_context_params` при создании контекста. Это стартовый параметр: после загрузки модели и создания контекста его нельзя изменить через HTTP API.

Практически это переключатель между доверием к исходной геометрии модели (`none`), линейным растяжением частот (`linear`) и YaRN (`yarn`). Для длинного контекста одного `--rope-scaling` обычно недостаточно: его проверяют вместе с `--ctx-size`, `--rope-scale` или `--rope-freq-scale` и YaRN-параметрами.

## Оригинальная справка llama.cpp

```text
RoPE frequency scaling method, defaults to linear unless specified by the model
```

## Паспорт аргумента

- Основное имя: `--rope-scaling`
- Алиасы: `--rope-scaling`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `enum`
- Формат: одно из `none`, `linear`, `yarn`
- Переменная окружения: `LLAMA_ARG_ROPE_SCALING_TYPE`
- Поле в `common_params`: `rope_scaling_type`
- Этап применения: парсинг CLI/env, затем создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` обработчик переводит строку в `LLAMA_ROPE_SCALING_TYPE_NONE`, `LLAMA_ROPE_SCALING_TYPE_LINEAR` или `LLAMA_ROPE_SCALING_TYPE_YARN`. Любое другое значение вызывает `invalid value` на этапе разбора аргументов.

В `common/common.cpp` значение копируется в `llama_context_params::rope_scaling_type`. В `src/llama-context.cpp`, если тип остался `LLAMA_ROPE_SCALING_TYPE_UNSPECIFIED`, контекст берет `hparams.rope_scaling_type_train` из метаданных модели. В `src/llama-model.cpp` тип из GGUF читается из ключа RoPE scaling; если ключ отсутствует, используется строка `linear`.

Особый случай: при `--rope-scaling none` llama.cpp принудительно ставит `rope_freq_scale = 1.0f`, то есть отключает частотное растяжение даже если рядом задан `--rope-scale` или `--rope-freq-scale`.

## Значения и формат

- `none`: не масштабировать RoPE; полезно для диагностики и запуска в пределах обучающего контекста.
- `linear`: линейное масштабирование частот. Фактический коэффициент задается `--rope-scale` или `--rope-freq-scale`, либо берется из модели.
- `yarn`: включает YaRN-ветку логики контекста. Если `--yarn-ext-factor` не задан, отрицательное значение по умолчанию превращается в `1.0` именно для `yarn`; для остальных типов оно становится `0.0`.

## Когда использовать

- Задавайте явно, когда нужно воспроизвести известную схему long-context запуска и не полагаться на метаданные GGUF.
- Используйте `none` для A/B-проверки, если после увеличения `--ctx-size` модель начинает терять качество, повторять текст или резко деградировать на длинных промптах.
- Используйте `yarn` только вместе с понятным набором YaRN-параметров или с моделью, в метаданных которой уже есть корректные значения.

## Влияние на производительность и память

Сам тип scaling почти не меняет размер весов модели. Основной расход памяти приходит от выбранного `--ctx-size`, числа слотов `--parallel` и KV-cache. При увеличении контекста растет память KV-cache и время prefill; scaling только определяет, как позиции будут интерпретироваться моделью.

## Взаимодействие с другими аргументами

- `--ctx-size` задает размер контекста, который вы пытаетесь использовать; RoPE scaling не увеличивает память сам по себе без большего контекста.
- `--rope-scale` и `--rope-freq-scale` пишут одно и то же поле `rope_freq_scale`, но в обратных формах. Последний указанный аргумент фактически выигрывает.
- `--rope-scaling none` переопределяет частотный scale на `1.0`.
- `--yarn-ext-factor`, `--yarn-attn-factor`, `--yarn-beta-fast`, `--yarn-beta-slow` и `--yarn-orig-ctx` имеют смысл прежде всего для `--rope-scaling yarn`.

## INI-пресеты и router-режим

В локальном `--models-preset` ключ пишется без дефисов:

```ini
[*]
ctx-size = 32768
rope-scaling = yarn
rope-scale = 4
```

В router-режиме дочерние model instance наследуют CLI и env родительского router-процесса, а model preset может задавать эти параметры для конкретной модели. По README llama.cpp, часть аргументов управляется router и удаляется или перезаписывается при загрузке; RoPE-параметры к таким служебным аргументам не относятся.

## Типовые проблемы и диагностика

- `invalid value`: проверьте регистр и точное значение. Допустимы только `none`, `linear`, `yarn`.
- Изменение не видно в поведении: проверьте, что вы действительно увеличили `--ctx-size`; без большего контекста эффект часто незаметен.
- Модель деградирует на длинном контексте: сравните запуск с `--rope-scaling none`, затем с `linear` и `yarn`, фиксируя один и тот же prompt.
- В логах модели полезны строки `rope scaling`, `freq_base_train`, `freq_scale_train`, `n_ctx_orig_yarn`; в логах контекста - `freq_base` и `freq_scale`.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4
```

```bash
llama-server --model /models/model.gguf --ctx-size 8192 --rope-scaling none
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
