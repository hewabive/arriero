---
schema: 1
primaryName: "--control-vector-scaled"
title: "--control-vector-scaled"
summary: "Загружает control vector с явным strength в формате `FNAME:SCALE`. Несколько vectors можно передать CSV-списком."
category: "Общие параметры"
valueType: "list"
estimation: "normal"
valueHint: "FNAME:SCALE,..."
aliases:
  - "--control-vector-scaled"
allowedValues: []
env: []
related:
  - "--control-vector"
  - "--control-vector-layer-range"
  - "--model"
---

# --control-vector-scaled

## Кратко

`--control-vector-scaled` добавляет control vector с заданным strength. Каждый CSV-элемент должен иметь формат `FNAME:SCALE`; обработчик записывает `{ strength = stof(SCALE), fname = FNAME }` в `common_params.control_vectors`.

## Оригинальная справка llama.cpp

```text
add a control vector with user defined scaling SCALE
note: use comma-separated values (format: FNAME:SCALE,...)
```

## Паспорт аргумента

- Основное имя: `--control-vector-scaled`
- Алиасы: `--control-vector-scaled`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `list`
- Подсказка формата из `--help`: `FNAME:SCALE,...`
- Переменные окружения: не указаны
- Значение по умолчанию: control vectors не применяются
- Внутреннее поле: `common_params.control_vectors`

## Что меняет в llama-server

На парсинге каждый элемент делится по `:`. Если частей не две, выбрасывается `control-vector-scaled format: FNAME:SCALE`. Scale читается через `std::stof`.

При загрузке vectors данные каждого tensor умножаются на strength и складываются с другими vectors. После этого общий vector применяется к диапазону слоев через `llama_set_adapter_cvec()`.

## Значения и формат

Примеры:

```text
--control-vector-scaled /srv/cvec/helpful.gguf:0.8
--control-vector-scaled /srv/cvec/a.gguf:0.5,/srv/cvec/b.gguf:-0.3
```

Отрицательный scale синтаксически допустим через `std::stof` и может инвертировать направление steering, если это осмысленно для конкретного vector.

## Когда использовать

Используйте, когда strength `1.0` слишком сильный/слабый или нужно смешать несколько steering directions. Меняйте scale малыми шагами и проверяйте качество на контрольных prompts.

## Влияние на производительность и память

Память определяется vector data, а не scale. Слишком большой по модулю scale может резко ухудшить качество генерации, даже если производительность почти не меняется.

## Взаимодействие с другими аргументами

- `--control-vector`: добавляет vectors со strength `1.0`; все vectors суммируются.
- `--control-vector-layer-range`: задает слой, на котором применяется уже суммированный vector.
- `--model`: vectors должны совпадать по `n_embd`.

## INI-пресеты и router-режим

```ini
[scaled_cvec]
model = /srv/models/base.gguf
control-vector-scaled = /srv/cvec/helpful.gguf:0.6
```

Если путь содержит `:`, формат становится неоднозначным. Для Linux production путей избегайте двоеточий в именах control vector файлов.

## Типовые проблемы и диагностика

- `control-vector-scaled format: FNAME:SCALE`: нарушен формат или в пути есть лишнее двоеточие.
- Ошибка преобразования scale: scale должен быть числом формата, принимаемого `std::stof`.
- Модель стала отвечать нестабильно: уменьшите `abs(scale)` или сузьте `--control-vector-layer-range`.

## Примеры

```bash
llama-server --model /srv/models/base.gguf --control-vector-scaled /srv/cvec/helpful.gguf:0.6
```

```bash
llama-server --model /srv/models/base.gguf --control-vector-scaled /srv/cvec/helpful.gguf:0.7,/srv/cvec/formal.gguf:0.3
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/common.h`
