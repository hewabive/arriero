---
schema: 1
primaryName: "--dynatemp-range"
title: "--dynatemp-range"
summary: "Включает динамическую температуру вокруг `--temp`: фактическая температура выбирается по энтропии распределения в диапазоне `[max(0, temp-range), temp+range]`. `0.0` отключает dynamic temperature."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--dynatemp-range"
allowedValues: []
env: []
related:
  - "--temp"
  - "--dynatemp-exp"
  - "--samplers"
---

# --dynatemp-range

## Кратко

`--dynatemp-range` включает dynamic temperature sampler. Вместо постоянного `--temp` llama.cpp вычисляет энтропию текущего распределения и выбирает температуру в диапазоне вокруг базового `--temp`.

## Оригинальная справка llama.cpp

```text
dynamic temperature range (default: 0.00, 0.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--dynatemp-range`
- Поле в `common_params`: `params.sampling.dynatemp_range`
- HTTP-поле: `dynatemp_range`
- Значение по умолчанию: `0.00`
- Отключение: `0.0` или меньше.

## Что меняет в llama-server

Параметр записывается в `params.sampling.dynatemp_range` и используется sampler-ом `temperature`/`t`, который создается как `llama_sampler_init_temp_ext(temp, dynatemp_range, dynatemp_exponent)`. Без `temperature` в sampler-цепочке dynamic temperature не применяется.

Текущая загрузка metadata модели не переопределяет `dynatemp_range`; HTTP-запрос может заменить дефолт через `"dynatemp_range"`.

## Значения и формат

- `0` - обычная постоянная температура.
- `0.1`-`0.3` - небольшой адаптивный диапазон.
- Фактический минимум: `max(0, temp - dynatemp_range)`.
- Фактический максимум: `temp + dynatemp_range`.

Если `--temp <= 0`, backend-ветка dynamic temperature откатывается к обычной температуре; CPU-ветка при положительном range все равно вычисляет dynamic temp с минимумом `0`.

## Когда использовать

- Когда на уверенных шагах нужны более строгие решения, а на неоднозначных - больше разнообразия.
- Для творческих задач, где постоянная температура либо слишком сухая, либо слишком шумная.
- Не начинайте tuning с dynamic temperature; сначала подберите базовые `--temp`, `--top-p`, `--min-p`.

## Влияние на производительность и память

Память не меняется. Dynamic temperature добавляет softmax и расчет энтропии на каждом шаге. Backend implementation для `temp_ext` есть, поэтому при совместимой цепочке часть работы может уйти на backend.

## Взаимодействие с другими аргументами

- `--temp` задает центр диапазона.
- `--dynatemp-exp` управляет кривой преобразования нормализованной энтропии.
- `--samplers` должен содержать `temperature`, `--sampler-seq` - `t`.
- Фильтры до температуры (`top_k`, `top_p`, `min_p`) меняют энтропию, а значит и выбранную dynamic temperature.

## INI-пресеты и router-режим

Ключ INI:

```ini
[dynamic]
temp = 0.8
dynatemp-range = 0.2
```

HTTP-поле для запроса: `"dynatemp_range"`.

## Типовые проблемы и диагностика

- Нет эффекта: `dynatemp_range <= 0` или в цепочке нет `temperature`/`t`.
- Слишком резкий стиль: уменьшите range или измените `--dynatemp-exp`.
- В trace-логе смотрите `sampler params`, где печатается `temp`, но сам range в этой строке не выводится; цепочку проверяйте по `sampler chain`.

## Примеры

```bash
llama-server --model /models/model.gguf --temp 0.8 --dynatemp-range 0.2
```

```bash
llama-server --model /models/model.gguf --temp 0.6 --dynatemp-range 0.1 --dynatemp-exp 1.5
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/README.md`
- `llama.cpp/tools/server/server-task.cpp`
