---
schema: 1
primaryName: "--rope-scale"
title: "--rope-scale"
summary: "Задает человекочитаемый коэффициент расширения RoPE-контекста: `N` превращается во внутренний `rope_freq_scale = 1/N`. Используется на старте при создании контекста и конфликтует с прямым `--rope-freq-scale`."
category: "Общие параметры"
valueType: "number"
valueHint: "N"
aliases:
  - "--rope-scale"
allowedValues: []
env:
  - "LLAMA_ARG_ROPE_SCALE"
related:
  - "--ctx-size"
  - "--rope-scaling"
  - "--rope-freq-scale"
  - "--yarn-orig-ctx"
---

# --rope-scale

## Кратко

`--rope-scale N` задает коэффициент расширения контекста в привычной форме: `N = 4` означает попытку растянуть RoPE примерно в 4 раза. В коде llama.cpp это сразу преобразуется в `params.rope_freq_scale = 1.0f / N`.

Аргумент не увеличивает `--ctx-size` автоматически. Он только меняет частотную шкалу RoPE для уже выбранного размера контекста.

## Оригинальная справка llama.cpp

```text
RoPE context scaling factor, expands context by a factor of N
```

## Паспорт аргумента

- Основное имя: `--rope-scale`
- Алиасы: `--rope-scale`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_ROPE_SCALE`
- Поле в `common_params`: `rope_freq_scale`, но в форме `1/N`
- Этап применения: парсинг CLI/env, затем создание `llama_context`

## Что меняет в llama-server

Обработчик в `common/arg.cpp` вычисляет `1.0f / std::stof(value)` и записывает результат в `common_params::rope_freq_scale`. Потом `common/common.cpp` переносит его в `llama_context_params::rope_freq_scale`.

В `src/llama-context.cpp`, если `rope_freq_scale` равен `0.0f`, llama.cpp берет обучающее значение из метаданных модели. У `--rope-scale` это важно: обычное положительное значение никогда не оставляет поле равным нулю. Например, `--rope-scale 4` дает внутренний `freq_scale = 0.25`.

## Значения и формат

- Рекомендуемые значения: положительные числа, обычно `1`, `2`, `4` или другое значение, соответствующее рецепту модели.
- `1` означает отсутствие расширения относительно базовой частотной шкалы: внутренний `freq_scale = 1`.
- Значение меньше `1` сжимает, а не расширяет частотную шкалу; для server-профилей это редко полезно.
- В коде нет явной проверки `N > 0`. Не используйте `0` и отрицательные значения: они дают бессмысленный или опасный внутренний scale.

## Когда использовать

- Когда документация модели говорит о context scaling в форме `rope_scale`, `factor` или "extend by 4x".
- Когда нужно явно задать коэффициент поверх метаданных GGUF.
- Когда вы предпочитаете не считать обратный `--rope-freq-scale` вручную.

## Влияние на производительность и память

Сам `--rope-scale` почти не влияет на RAM/VRAM. Память растет от фактического `--ctx-size`, `--parallel` и типа KV-cache. Однако агрессивное растяжение часто ухудшает качество на длинном контексте, поэтому его проверяют функциональными тестами, а не только метриками памяти.

## Взаимодействие с другими аргументами

- `--rope-freq-scale` пишет то же поле напрямую. Если указать оба аргумента, фактически останется значение последнего обработанного CLI/env параметра.
- `--rope-scaling none` в контексте принудительно сбрасывает `rope_freq_scale` в `1.0`.
- Для YaRN `--rope-scale` влияет на расчет фактора `1.0f / rope_freq_scale`, который используется при автоматическом вычислении `yarn_attn_factor`.
- `--ctx-size` должен соответствовать желаемому контексту; без него расширение RoPE не даст большего окна.

## INI-пресеты и router-режим

В локальном `--models-preset`:

```ini
[my-model]
ctx-size = 32768
rope-scaling = linear
rope-scale = 4
```

Router-процесс передает этот параметр дочернему `llama-server` как обычный аргумент модели. Если значение задано и в CLI router-а, и в preset конкретной модели, README описывает приоритет CLI выше model-specific preset.

## Типовые проблемы и диагностика

- Контекст не увеличился: проверьте `--ctx-size`, потому что `--rope-scale` не меняет его.
- Случайно задан `--rope-scale 0`: уберите параметр или задайте положительный коэффициент; `0` не означает "из модели".
- Конфликт с `--rope-freq-scale`: оставьте только одну форму, чтобы в конфигурации было понятно, какой scale применяется.
- В логах сверяйте `freq_scale` при создании контекста: для `--rope-scale 4` ожидается примерно `0.25`.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-scaling linear --rope-scale 4
```

```bash
LLAMA_ARG_ROPE_SCALE=2 llama-server --model /models/model.gguf --ctx-size 16384
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/tools/server/README.md`
