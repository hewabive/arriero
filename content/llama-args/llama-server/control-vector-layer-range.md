---
schema: 1
primaryName: "--control-vector-layer-range"
title: "--control-vector-layer-range"
summary: "Ограничивает inclusive диапазон слоев, к которым применяется control vector. Если диапазон не задан, используется `1..n_layer`."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "START END"
aliases:
  - "--control-vector-layer-range"
allowedValues: []
env: []
related:
  - "--control-vector"
  - "--control-vector-scaled"
  - "--model"
---

# --control-vector-layer-range

## Кратко

`--control-vector-layer-range` задает inclusive диапазон слоев для применения control vector. Обработчик читает два аргумента `START` и `END`, сохраняет их в `common_params.control_vector_layer_start` и `common_params.control_vector_layer_end`.

Если control vectors есть, но диапазон не задан или значения `<= 0`, llama.cpp заменяет start на `1`, end на `llama_model_n_layer(model)`.

## Оригинальная справка llama.cpp

```text
layer range to apply the control vector(s) to, start and end inclusive
```

## Паспорт аргумента

- Основное имя: `--control-vector-layer-range`
- Алиасы: `--control-vector-layer-range`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `START END`
- Переменные окружения: не указаны
- Значение по умолчанию: `1..n_layer` при наличии control vectors
- Внутренние поля: `common_params.control_vector_layer_start`, `common_params.control_vector_layer_end`

## Что меняет в llama-server

При наличии control vectors диапазон передается в:

```text
llama_set_adapter_cvec(ctx, data, size, n_embd, start, end)
```

Диапазон inclusive, то есть `4 28` включает и layer 4, и layer 28. Tensor data в vector хранится для layers `[1, n_layer]`; layer `0` не используется.

## Значения и формат

CLI требует два отдельных значения:

```text
--control-vector-layer-range 4 28
```

Оба значения парсятся через `std::stoi`. В `arg.cpp` нет явной проверки, что start <= end или что end не больше числа слоев; некорректный диапазон проявится при применении adapter или в качестве результата.

## Когда использовать

Используйте диапазон, когда control vector слишком сильно влияет на всю модель или был рассчитан для определенной части слоев. Без необходимости оставляйте default: весь диапазон слоев модели.

## Влияние на производительность и память

Диапазон меняет область применения vector, а не размер загружаемого файла. Узкий диапазон может уменьшить вычислительное влияние adapter и изменить качество steering, но не обязан заметно снизить memory footprint, потому что vector data уже загружен.

## Взаимодействие с другими аргументами

- `--control-vector` и `--control-vector-scaled`: диапазон имеет смысл только если задан хотя бы один vector.
- `--model`: число слоев и `n_embd` берутся из базовой модели.
- `--lora`: может использоваться вместе, но эффекты adapters накладываются.

## INI-пресеты и router-режим

```ini
[cvec_middle_layers]
model = /srv/models/base.gguf
control-vector = /srv/cvec/helpful.gguf
control-vector-layer-range = 4 28
```

В preset значение должно сохранять два числа как аргументы одного параметра. Проверьте, как arriero сериализует multi-value параметры в argv.

## Типовые проблемы и диагностика

- CLI ошибка парсинга: передано не два числа.
- Steering не ощущается: диапазон слишком узкий или не включает слои, где vector содержит directions.
- Генерация деградирует: сузьте диапазон или уменьшите scale через `--control-vector-scaled`.

## Примеры

```bash
llama-server --model /srv/models/base.gguf --control-vector /srv/cvec/helpful.gguf --control-vector-layer-range 4 28
```

```bash
llama-server --model /srv/models/base.gguf --control-vector-scaled /srv/cvec/helpful.gguf:0.5 --control-vector-layer-range 1 16
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/common.h`
