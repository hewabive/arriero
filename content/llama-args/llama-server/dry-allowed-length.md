---
schema: 1
primaryName: "--dry-allowed-length"
title: "--dry-allowed-length"
summary: "Задает, сколько токенов повторяющейся последовательности DRY допускает без штрафа. Default `2` начинает штрафовать только продолжение более длинного повтора."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--dry-allowed-length"
allowedValues: []
env: []
related:
  - "--dry-multiplier"
  - "--dry-base"
  - "--dry-penalty-last-n"
  - "--dry-sequence-breaker"
---

# --dry-allowed-length

## Кратко

`--dry-allowed-length` задает допустимую длину повторяющейся последовательности до включения DRY penalty. Это главный параметр, который отличает "разрешить короткий повтор" от "давить почти любое продолжение повтора".

Default: `2`.

## Оригинальная справка llama.cpp

```text
set allowed length for DRY sampling (default: 2)
```

## Паспорт аргумента

- Основное имя: `--dry-allowed-length`
- Алиасы: `--dry-allowed-length`
- Тип CLI-значения: целое число `N`
- Поле в `common_params_sampling`: `dry_allowed_length`
- HTTP-поле: `dry_allowed_length`
- Значение по умолчанию: `2`
- Явной проверки диапазона в `arg.cpp` и `server-task.cpp` для этого поля нет.

## Что меняет в llama-server

Значение передается в `llama_sampler_init_dry`. По описанию README, токены получают экспоненциально растущий штраф, когда продолжают повтор за пределами allowed length: `multiplier * base ^ (length of repeating sequence before token - allowed length)`.

Если `--dry-multiplier 0`, изменение `--dry-allowed-length` не влияет на генерацию.

## Значения и формат

- `2`: default.
- Меньше значение: DRY начинает штрафовать раньше.
- Больше значение: DRY терпимее к коротким повторяющимся фрагментам.
- Нулевые и отрицательные значения не отклоняются явной проверкой в изученном коде, но для production их лучше не использовать без отдельного теста.

## Когда использовать

Увеличивайте `--dry-allowed-length`, если DRY мешает нормальным повторениям: структурам JSON, спискам, одинаковым markdown-префиксам, повторным именам функций. Уменьшайте, если модель быстро входит в короткие циклы.

## Влияние на производительность и память

Память и KV-cache не меняются. Значение влияет на то, какие повторные последовательности будут штрафоваться, а стоимость поиска повторов в основном задает `--dry-penalty-last-n`.

## Взаимодействие с другими аргументами

- `--dry-multiplier`: включает и масштабирует DRY.
- `--dry-base`: определяет рост штрафа после allowed length.
- `--dry-penalty-last-n`: ограничивает историю поиска повторов.
- `--dry-sequence-breaker`: может разрывать последовательности так, что allowed length считается внутри сегментов.
- `--samplers` и `--mirostat`: определяют, будет ли `dry` sampler создан.

## INI-пресеты и router-режим

Допустим в `--models-preset` как sampling option:

```ini
[model.default]
dry-multiplier = 0.8
dry-allowed-length = 3
```

Per-request поле: `dry_allowed_length`.

## Типовые проблемы и диагностика

- DRY ломает форматированные ответы: увеличьте `--dry-allowed-length`.
- DRY не останавливает короткие циклы: уменьшите `--dry-allowed-length` или увеличьте `--dry-multiplier`.
- Параметр не влияет: проверьте `dry_multiplier > 0`, наличие `dry` в `--samplers` и `--mirostat 0`.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-allowed-length 3
```

```json
{
  "prompt": "Сгенерируй список объектов",
  "dry_multiplier": 0.6,
  "dry_allowed_length": 4
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--dry-allowed-length`.
- `llama.cpp/common/common.h`: default `dry_allowed_length = 2`.
- `llama.cpp/common/sampling.cpp`: `llama_sampler_init_dry`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `dry_allowed_length`.
- `llama.cpp/tools/server/README.md`: описание формулы DRY.
