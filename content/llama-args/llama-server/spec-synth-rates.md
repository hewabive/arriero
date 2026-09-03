---
schema: 1
primaryName: "--spec-synth-rates"
title: "--spec-synth-rates"
summary: "Задаёт безусловную вероятность принять draft до каждой позиции для synthetic speculative benchmark. Список должен совпадать с effective draft limit и убывать; output в этом режиме заведомо невалиден как ответ модели."
category: "Параметры speculative decoding"
valueType: "list"
estimation: "normal"
valueHint: "P0,P1,..."
aliases:
  - "--spec-synth-rates"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_SYNTH_RATES"
related:
  - "--spec-synth-len"
  - "--spec-type"
  - "--spec-draft-n-max"
  - "--spec-draft-model"
  - "--seed"
---

# --spec-synth-rates

## Кратко

`--spec-synth-rates P0,P1,...` включает synthetic acceptance и напрямую задаёт вероятность того, что draft дойдёт до каждой позиции. `Pi` — безусловная вероятность принять первые `i + 1` draft tokens, а не отдельная вероятность токена после предыдущего успеха.

Это benchmark-only режим. Принятые tokens могут не совпадать с target model, поэтому сгенерированный текст нельзя считать корректным output.

## Оригинальная справка llama.cpp

```text
comma-separated unconditional per-position synthetic acceptance probabilities (benchmarking only)
```

## Паспорт аргумента

- Основное имя: `--spec-synth-rates`
- Формат: CSV из чисел `P0,P1,...`
- Переменная окружения: `LLAMA_ARG_SPEC_SYNTH_RATES`
- Поле: `common_params::speculative.synth_rates`
- Значение по умолчанию: пустой список, synthetic acceptance выключен
- Этап применения: validation при создании speculative context, затем случайное verification каждого draft

## Что меняет в llama-server

Server преобразует безусловные rates в условные вероятности: первая остаётся `P0`, каждая следующая равна `Pi / P(i-1)` (после нулевой предыдущей — `0`). При verification эти вероятности управляют случайным принятием draft tokens вместо проверки target match.

Target/draft вычисления и timing counters остаются активными, поэтому конфигурация моделирует заданную acceptance curve при реальной стоимости выбранной speculative implementation.

## Значения и формат

Список обязан удовлетворять всем условиям:

- число элементов равно эффективному максимуму draft tokens `K`;
- каждый элемент конечен и лежит в `[0, 1]`;
- последовательность монотонно не возрастает.

Например, `0.8,0.6,0.3,0.1` означает 80% шанса принять хотя бы один token, 60% — первые два, 30% — первые три и 10% — все четыре. `--spec-synth-len` одновременно задавать нельзя.

## Когда использовать

Используйте для benchmark-а с известной эмпирической acceptance curve или чтобы отдельно смоделировать деградацию на поздних draft positions. Для одного целевого среднего значения проще `--spec-synth-len`.

Никогда не включайте флаг на listener, отдающий пользовательские ответы.

## Влияние на производительность и память

Список из `K` чисел незначителен по памяти. Фактические VRAM/RAM определяются draft implementation и `K`; rates изменяют долю принятой работы и тем самым измеряемые throughput/latency.

Высокие rates могут показать теоретический верхний предел ускорения, но не доказывают, что реальная draft model достигает такой точности.

## Взаимодействие с другими аргументами

- `--spec-draft-n-max` задаёт configured длину, но проверяется effective `K` после возможного clamp выбранной implementation.
- `--spec-type` обязан создать хотя бы одну speculative implementation.
- `--spec-synth-len` взаимоисключающий способ построить геометрическую curve по средней длине.
- `--seed` позволяет повторять одинаковую последовательность random decisions.

## INI-пресеты и router-режим

Используйте только отдельный benchmark preset:

```ini
[spec-benchmark]
spec-type = draft-simple
spec-draft-n-max = 4
spec-synth-rates = 0.8,0.6,0.3,0.1
```

Не наследуйте такой preset production-моделью: ответы будут недостоверны.

## Типовые проблемы и диагностика

- `must contain K values`: длина CSV не совпала с effective draft limit.
- `must be finite and within [0, 1]`: одно значение вне диапазона либо не является конечным числом.
- `must be monotonically non-increasing`: более поздняя безусловная вероятность выше предыдущей.
- `synthetic acceptance length and rates are mutually exclusive`: одновременно задан `--spec-synth-len`.
- Успешная активация подтверждается warning о невалидном output и логом итоговых `rates`/`mean length`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-type draft-simple --spec-draft-model /models/draft.gguf --spec-draft-n-max 4 --spec-synth-rates 0.8,0.6,0.3,0.1 --seed 42
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/tests/unit/test_speculative.py`
- https://github.com/ggml-org/llama.cpp/pull/27711
