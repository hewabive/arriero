---
schema: 1
primaryName: "--rope-freq-base"
title: "--rope-freq-base"
summary: "Переопределяет базовую частоту RoPE (`rope_freq_base`) для контекста. Значение `0` или отсутствие аргумента оставляет частоту из метаданных модели."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--rope-freq-base"
allowedValues: []
env:
  - "LLAMA_ARG_ROPE_FREQ_BASE"
related:
  - "--ctx-size"
  - "--rope-scaling"
  - "--rope-scale"
  - "--rope-freq-scale"
---

# --rope-freq-base

## Кратко

`--rope-freq-base` задает базовую частоту RoPE, которую llama.cpp использует при построении позиционных частот контекста. По умолчанию значение загружается из модели; если в GGUF нет явного ключа, `src/llama-model.cpp` использует `10000.0`.

Это низкоуровневый параметр. Для обычного расширения контекста чаще используют `--rope-scale` или `--rope-freq-scale`, а `--rope-freq-base` меняют только по рецепту конкретной модели.

## Оригинальная справка llama.cpp

```text
RoPE base frequency, used by NTK-aware scaling (default: loaded from model)
```

## Паспорт аргумента

- Основное имя: `--rope-freq-base`
- Алиасы: `--rope-freq-base`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: число, передаваемое в `std::stof`
- Переменная окружения: `LLAMA_ARG_ROPE_FREQ_BASE`
- Поле в `common_params`: `rope_freq_base`
- Этап применения: парсинг CLI/env, затем создание `llama_context`

## Что меняет в llama-server

В `common/arg.cpp` значение записывается в `common_params::rope_freq_base`. В `common/common.cpp` оно переносится в `llama_context_params::rope_freq_base`. При создании контекста `src/llama-context.cpp` применяет правило: если значение равно `0.0f`, использовать `hparams.rope_freq_base_train` из модели, иначе использовать заданное CLI/env значение.

Логи модели показывают `freq_base_train`, а логи контекста - фактическое `freq_base`.

## Значения и формат

- Обычная безопасная форма: положительное число, например `10000`, если это прямо требуется.
- `0` означает "оставить значение модели" на этапе создания контекста.
- В коде нет специальной проверки диапазона. Отрицательные и очень маленькие значения технически могут распарситься, но для RoPE они не являются нормальной эксплуатационной настройкой.

## Когда использовать

- При переносе известного NTK-aware рецепта, где явно указан `rope_freq_base`.
- При отладке модели с некорректными или неполными GGUF metadata.
- При сравнении нескольких long-context конфигураций, когда остальные параметры зафиксированы.

## Влияние на производительность и память

Размер KV-cache и весов не меняется от `--rope-freq-base`. Влияние проявляется в качестве и стабильности генерации, особенно на позициях далеко за обучающим контекстом. Неверное значение может ухудшить ответы без явной ошибки запуска.

## Взаимодействие с другими аргументами

- `--rope-scaling` определяет тип scaling, а `--rope-freq-base` - базовую частоту.
- `--rope-scale` или `--rope-freq-scale` задают частотный scale отдельно от base.
- `--ctx-size` определяет, насколько далеко сервер реально будет заходить по позициям.
- `--override-kv` может менять metadata модели до загрузки, но для RoPE-параметров прямые CLI-аргументы обычно понятнее и проще диагностируются.

## INI-пресеты и router-режим

```ini
[long-context-model]
ctx-size = 32768
rope-scaling = linear
rope-freq-base = 10000
rope-scale = 4
```

В router-режиме параметр можно задавать в model preset. Он применяется в дочернем процессе модели при создании контекста, а не в самом router-процессе.

## Типовые проблемы и диагностика

- Качество стало хуже без падения сервера: верните `rope-freq-base = 0` или уберите аргумент, чтобы проверить значение из модели.
- Настройка не видна в логах: ищите `freq_base` в логах контекста, а не только `freq_base_train` в логах загрузки модели.
- Конфигурация смешивает metadata override и CLI RoPE: оставьте один способ задания, чтобы исключить неоднозначность.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --rope-freq-base 10000 --rope-scale 4
```

```bash
llama-server --model /models/model.gguf --rope-freq-base 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
