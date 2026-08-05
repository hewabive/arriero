---
schema: 1
primaryName: "--dynatemp-exp"
title: "--dynatemp-exp"
summary: "Экспонента dynamic temperature: управляет тем, как нормализованная энтропия распределения превращается в температуру внутри диапазона `--dynatemp-range`. Работает только когда dynamic temperature включена."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--dynatemp-exp"
allowedValues: []
env: []
related:
  - "--dynatemp-range"
  - "--temp"
  - "--samplers"
---

# --dynatemp-exp

## Кратко

`--dynatemp-exp` меняет кривую dynamic temperature. При активном `--dynatemp-range` llama.cpp нормализует энтропию распределения и вычисляет температуру по степенной функции; exponent задает степень этой функции.

## Оригинальная справка llama.cpp

```text
dynamic temperature exponent (default: 1.00)
```

## Паспорт аргумента

- Основное имя: `--dynatemp-exp`
- Поле в `common_params`: `params.sampling.dynatemp_exponent`
- HTTP-поле: `dynatemp_exponent`
- Значение по умолчанию: `1.00`
- Этап применения: sampler `temperature`/`temp_ext`.

## Что меняет в llama-server

CLI-парсер записывает float в `params.sampling.dynatemp_exponent`. Сам по себе параметр не включает dynamic temperature: при `--dynatemp-range 0` он хранится, но не влияет на logits.

В реализации dynamic temperature рассчитывается как `min_temp + (max_temp - min_temp) * pow(normalized_entropy, exponent)`.

## Значения и формат

- `1.0` - линейная зависимость от нормализованной энтропии.
- `> 1.0` - сильнее держит температуру ближе к нижней части диапазона при умеренной энтропии.
- `0 < N < 1` - быстрее поднимает температуру к верхней части диапазона.
- `0` и отрицательные значения CLI принимает; это экспериментальная зона, проверяйте контрольными запросами.

## Когда использовать

- Меняйте после того, как подобраны `--temp` и `--dynatemp-range`.
- Увеличивайте, если dynamic temperature слишком часто делает текст шумным.
- Уменьшайте, если adaptive-разброс почти не ощущается.

## Влияние на производительность и память

Память не меняется. Стоимость появляется только при активном `--dynatemp-range`; exponent участвует в `powf`/эквивалентной backend-операции.

## Взаимодействие с другими аргументами

- Без `--dynatemp-range > 0` не влияет.
- Без `temperature` в `--samplers` или `t` в `--sampler-seq` не применяется.
- Фильтры перед температурой меняют энтропию и косвенно меняют эффект exponent.

## INI-пресеты и router-режим

Ключ INI:

```ini
[dynamic]
dynatemp-exp = 1.5
```

В HTTP API поле называется `"dynatemp_exponent"`, не `"dynatemp_exp"`.

## Типовые проблемы и диагностика

- `--dynatemp-exp` не меняет ответы: проверьте `--dynatemp-range`, `--temp` и наличие `temperature`/`t` в цепочке.
- Результат трудно воспроизвести: фиксируйте `--seed` и все фильтры до температуры.

## Примеры

```bash
llama-server --model /models/model.gguf --temp 0.8 --dynatemp-range 0.2 --dynatemp-exp 1.5
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-task.cpp`
