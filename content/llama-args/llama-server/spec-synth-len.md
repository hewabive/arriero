---
schema: 1
primaryName: "--spec-synth-len"
title: "--spec-synth-len"
summary: "Подменяет реальную проверку speculative tokens синтетической вероятностной моделью с заданной средней accepted length. Это только benchmark-инструмент: с ним server намеренно выдаёт недостоверный model output."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "L"
aliases:
  - "--spec-synth-len"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_SYNTH_LEN"
related:
  - "--spec-synth-rates"
  - "--spec-type"
  - "--spec-draft-n-max"
  - "--spec-draft-model"
  - "--seed"
---

# --spec-synth-len

## Кратко

`--spec-synth-len L` включает synthetic acceptance для benchmark-а speculative decoding. Вместо сравнения draft tokens с target model server случайно принимает их так, чтобы средняя длина шага, включая обязательный target token, была `L`.

Полученный текст не является корректным output модели: принятый draft token может не совпадать с target. Флаг нельзя использовать для обычного serving или проверки качества.

## Оригинальная справка llama.cpp

```text
target mean synthetic acceptance length, including the target token (benchmarking only)
```

## Паспорт аргумента

- Основное имя: `--spec-synth-len`
- Формат: конечное число с плавающей точкой `L`
- Переменная окружения: `LLAMA_ARG_SPEC_SYNTH_LEN`
- Поле: `common_params::speculative.synth_len`
- Значение по умолчанию: `-1`, synthetic acceptance выключен
- Этап применения: инициализация speculative context и verification каждого draft

## Что меняет в llama-server

Пусть эффективный максимум speculative tokens равен `K`. Server подбирает постоянную условную вероятность `p`, для которой `p + p² + … + pᴷ = L - 1`, и строит безусловные per-position rates `[p, p², …, pᴷ]`. При verification решение принимается генератором случайных чисел вместо проверки совпадения с target token.

Draft implementation всё равно реально работает, target logits вычисляются и timing counters заполняются. Меняется именно решение о принятии tokens, поэтому режим позволяет измерять throughput при контролируемой acceptance length.

## Значения и формат

Для эффективного `K` допустим диапазон `1 ≤ L ≤ K + 1`:

- `L = 1`: все draft tokens отклоняются;
- `L = K + 1`: все допустимые draft tokens принимаются;
- промежуточное значение задаёт рассчитанную геометрическую кривую acceptance.

`NaN`, infinity и значение вне диапазона отклоняются при инициализации. `--spec-synth-len` и `--spec-synth-rates` взаимоисключающие.

## Когда использовать

Только для воспроизводимого benchmark-а speculative implementation: сравнения scheduler/verification overhead при разных acceptance regimes или моделирования потенциальной draft-модели. Не используйте результаты как ответы API, quality samples или regression golden output.

## Влияние на производительность и память

Память определяется выбранным `--spec-type`, draft model, `K` и `--parallel`; сам scalar `L` почти ничего не добавляет. Производительность меняется намеренно: более высокий `L` уменьшает число target steps на выданный token и моделирует лучшую acceptance.

Это не ускорение реального качества: режим лишь заменяет корректность статистическим допущением.

## Взаимодействие с другими аргументами

- Требуется инициализированный speculative context через `--spec-type`; иначе server завершится с `synthetic acceptance requires an initialized speculative decoding context`.
- `--spec-draft-n-max` задаёт configured `K`, но implementation может уменьшить его; проверка `L` использует эффективное значение после инициализации.
- `--spec-synth-rates` задаёт кривую напрямую и не может использоваться одновременно.
- `--seed` делает случайные synthetic decisions воспроизводимыми для одинакового запроса и конфигурации.

## INI-пресеты и router-режим

Не помещайте synthetic acceptance в production preset. Для изолированного benchmark preset:

```ini
[spec-benchmark]
spec-type = draft-simple
spec-draft-n-max = 8
spec-synth-len = 4.0
```

## Типовые проблемы и диагностика

- `synthetic acceptance length and rates are mutually exclusive`: оставьте только один synthetic-флаг.
- `must be finite and within [1, ...]`: `L` не соответствует effective draft limit.
- `requires at least one speculative token`: выбранная implementation не даёт ни одного draft token.
- При успешном старте server выводит warning `generated output is not valid` и строку `synthetic acceptance: n_max = ..., mean length = ..., rates = [...]`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-type draft-simple --spec-draft-model /models/draft.gguf --spec-draft-n-max 8 --spec-synth-len 4.0 --seed 42
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/tests/unit/test_speculative.py`
- https://github.com/ggml-org/llama.cpp/pull/27711
