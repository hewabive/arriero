---
schema: 1
primaryName: "--yarn-attn-factor"
title: "--yarn-attn-factor"
summary: "Задает YaRN attention magnitude factor. По умолчанию `-1` означает значение из модели, но при активном YaRN extrapolation llama.cpp может пересчитать factor автоматически."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--yarn-attn-factor"
allowedValues: []
env:
  - "LLAMA_ARG_YARN_ATTN_FACTOR"
related:
  - "--rope-scaling"
  - "--rope-scale"
  - "--rope-freq-scale"
  - "--yarn-ext-factor"
---

# --yarn-attn-factor

## Кратко

`--yarn-attn-factor` задает масштаб attention magnitude для YaRN. В defaults llama.cpp хранит `-1`, что означает "не задано; взять из hparams модели".

Важно: при `yarn_ext_factor != 0` в `src/llama-context.cpp` код вычисляет новый `yarn_attn_factor` на основе RoPE scale и может заменить ранее выбранное значение. Затем результат дополнительно умножается на `hparams.rope_attn_factor`.

## Оригинальная справка llama.cpp

```text
YaRN: scale sqrt(t) or attention magnitude (default: -1.00)
```

## Паспорт аргумента

- Основное имя: `--yarn-attn-factor`
- Алиасы: `--yarn-attn-factor`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_YARN_ATTN_FACTOR`
- Поле в `common_params`: `yarn_attn_factor`
- Этап применения: создание `llama_context`

## Что меняет в llama-server

Обработчик CLI записывает float в `params.yarn_attn_factor`. При создании контекста отрицательное значение заменяется на `hparams.yarn_attn_factor`. Если YaRN extrapolation активен, `llama-context.cpp` рассчитывает attention factor через `get_mscale(...)`; для некоторых моделей с `rope_yarn_log_mul` логируется предупреждение `setting new yarn_attn_factor`.

## Значения и формат

- `-1`: auto/unset, default llama.cpp.
- Положительные float-значения: ручное задание magnitude factor.
- `0` технически допустим как число, но для эксплуатации требует очень веской причины, потому что влияет на масштаб attention.

## Когда использовать

- Когда рецепт модели явно задает YaRN attention factor.
- Когда нужно воспроизвести старую long-context конфигурацию.
- При отладке DeepSeek/YaRN metadata, где важно сравнить автоматический и ручной расчет.

## Влияние на производительность и память

Память и throughput почти не меняются напрямую. Риск состоит в качестве: неверный attention magnitude может давать деградацию, повторения или слишком слабое использование дальнего контекста.

## Взаимодействие с другими аргументами

- `--yarn-ext-factor` определяет, будет ли выполнена автоматическая YaRN-ветка пересчета.
- `--rope-scale` и `--rope-freq-scale` влияют на factor для расчета `get_mscale`.
- `--rope-scaling yarn` делает YaRN-параметры частью выбранного scaling режима.
- `--yarn-beta-fast` и `--yarn-beta-slow` задают correction dim/alpha-beta параметры отдельно от attention factor.

## INI-пресеты и router-режим

```ini
[my-yarn-model]
rope-scaling = yarn
rope-scale = 4
yarn-attn-factor = 1
```

В router mode задавайте параметр в model preset, если он нужен только конкретной модели. Глобальное CLI-значение router-а наследуется всеми дочерними model instance.

## Типовые проблемы и диагностика

- Ручное значение будто игнорируется: проверьте, активен ли `--yarn-ext-factor` не равный `0`; код может пересчитать factor.
- В логах есть warning `setting new yarn_attn_factor`: это результат автоматического расчета в `llama-context.cpp`.
- Качество хуже на длинном контексте: верните `-1` и сравните с metadata/default модели.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-attn-factor 1
```

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling yarn --rope-scale 4 --yarn-attn-factor -1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
