---
schema: 1
primaryName: "--spec-draft-n-max"
title: "--spec-draft-n-max"
summary: "Задает максимальную длину draft-последовательности для draft-model/MTP speculative decoding. Большее значение может повысить throughput при высокой acceptance, но увеличивает работу на неудачные draft."
category: "Параметры speculative decoding"
valueType: "number"
valueHint: "N"
aliases:
  - "--spec-draft-n-max"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_N_MAX"
related:
  - "--spec-draft-n-min"
  - "--spec-draft-p-min"
  - "--spec-type"
  - "--spec-draft-model"
  - "--parallel"
---

# --spec-draft-n-max

## Кратко

`--spec-draft-n-max` задает `common_params.speculative.draft.n_max`: верхний предел числа токенов, которые draft-model/MTP реализация пытается предложить за один speculative шаг. Значение по умолчанию - `3`.

Дополнительно сервер ограничивает draft длиной, которая помещается в слот: `n_ctx - prompt.n_tokens() - 2`, а при конечном бюджете генерации еще и `n_remaining - 1`.

## Оригинальная справка llama.cpp

```text
number of tokens to draft for speculative decoding (default: 3)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-n-max`
- Значение: целое число
- Структура llama.cpp: `common_params.speculative.draft.n_max`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_N_MAX`
- Значение по умолчанию: `3`
- Этап применения: парсинг CLI/env, затем цикл draft generation в `common/speculative.cpp`

## Что меняет в llama-server

В `draft-simple` и `draft-mtp` цикл добавляет токены, пока не достигнут `params.n_max`, per-slot лимит `dp.n_max`, либо пока probability top-кандидата ниже `--spec-draft-p-min`. После генерации `common_speculative_draft()` дополнительно обрезает результат до `dp.n_max`, если слот не может вместить весь draft.

HTTP-переопределение `speculative.n_max` в `server-task.cpp` в текущем commit находится внутри `#if 0`, поэтому запросы к server API не меняют CLI/env значение.

## Значения и формат

Парсер принимает `int` через `std::stoi()` без явной проверки диапазона в обработчике. Практически используйте `0` и положительные значения осторожно: код draft-loop не документирует `0` как "выключить speculative"; для отключения используйте `--spec-type none` или не задавайте draft-тип.

Не ставьте `--spec-draft-n-min` выше `--spec-draft-n-max`: runtime-нормализация для CLI сейчас не выполняется.

## Когда использовать

Увеличивайте `N`, если draft acceptance высокая и draft-модель заметно быстрее target. Уменьшайте, если acceptance низкая, много partial rollback/checkpoint overhead или latency отдельных ответов важнее throughput.

## Влияние на производительность и память

Большее `N` увеличивает потенциальное число target-токенов, подтверждаемых одним шагом, но также увеличивает работу draft-модели и объем speculative verification. При контекстах без дешевого sequence removal сервер может использовать checkpoints, что делает длинные draft дороже.

Для target-архитектур, поддерживающих partial rollback recurrent state в текущем llama.cpp (`qwen35`, `qwen35moe`, `deepseek4`), MTP/Eagle3/DFlash/DSpark передают это значение как `n_rs_seq`. Постоянный target RS buffer тогда содержит `1 + N` state planes на каждый slot, то есть растет линейно с `--spec-draft-n-max` и `--parallel`. На Qwen3.5 0.8B + DSpark при одном slot измерено 38.53/77.06/154.12 MiB для N=1/3/7. На остальных recurrent architectures llama.cpp clamp-ит `n_rs_seq` к нулю.

Диагностика: смотрите `accepted X/Y draft tokens`, `draft acceptance = ...`, а также `created speculative checkpoint ...`.

## Взаимодействие с другими аргументами

`--spec-draft-n-min` может очистить короткий draft, если он меньше минимума. `--spec-draft-p-min` часто является главным ограничителем длины: высокий порог останавливает draft раньше `n_max`. `--parallel` влияет на число speculative последовательностей и память draft-контекста.

## INI-пресеты и router-режим

В INI используйте `spec-draft-n-max = 8`. Для разных моделей держите значение в model preset, потому что оптимальный draft depth зависит от пары target/draft.

## Типовые проблемы и диагностика

- Нет ускорения при большом N: acceptance низкая, уменьшите N или повысьте качество draft-модели.
- Частые checkpoints: контекст плохо поддерживает partial removal для такой длины draft.
- Значение из API не действует: в текущем commit runtime-переопределение speculative параметров отключено в `server-task.cpp`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-n-max 8
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-task.cpp`
