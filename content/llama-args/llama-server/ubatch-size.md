---
schema: 1
primaryName: "--ubatch-size"
title: "--ubatch-size"
summary: "Физический maximum micro-batch size для backend-вычисления. Обычно это первый параметр, который уменьшают при OOM на prompt processing."
category: "Общие параметры"
valueType: "number"
valueHint: "N"
aliases:
  - "-ub"
  - "--ubatch-size"
allowedValues: []
env:
  - "LLAMA_ARG_UBATCH"
related:
  - "--batch-size"
  - "--ctx-size"
  - "--parallel"
  - "--cont-batching"
  - "--threads-batch"
---

# --ubatch-size

## Кратко

`--ubatch-size` задает `common_params::n_ubatch`, затем `llama_context_params::n_ubatch`: физический максимум micro-batch для prompt/decode вычислений.

Если `--batch-size` отвечает за логическую упаковку токенов, то `--ubatch-size` отвечает за то, какими порциями backend реально выполняет граф.

## Оригинальная справка llama.cpp

```text
physical maximum batch size (default: 512)
```

## Паспорт аргумента

- Основное имя: `--ubatch-size`
- Алиасы: `-ub`, `--ubatch-size`
- Значение: целое число токенов
- Значение по умолчанию: `512`
- Переменная окружения: `LLAMA_ARG_UBATCH`
- Поле llama.cpp: `common_params::n_ubatch`
- Этап применения: создание `llama_context`

## Что меняет в llama-server

В `llama-context.cpp` фактический `n_ubatch` считается как `min(n_batch, requested_ubatch)`. Если передать `--ubatch-size 0`, backend берет `n_ubatch = n_batch`.

Для embedding-режима сервер требует, чтобы все токены embedding-запроса помещались в один ubatch. Если `--embedding` включен и `n_batch > n_ubatch`, `server.cpp` выставляет оба значения равными `n_ubatch`, чтобы избежать assertion failure.

## Значения и формат

- Положительное число: физический micro-batch limit.
- `0`: использовать фактический `n_batch`.
- Значения ниже 32 могут ухудшить или отключить эффективный BLAS-путь.
- Отрицательные значения не описаны как валидные и отклоняются Arriero до расчета. Ноль сохранен как поддерживаемая текущим llama.cpp форма `n_ubatch = n_batch`; оценщик не подменяет его дефолтом 512.
- Исключение текущего server-wrapper: вместе с `--embedding` или `--rerank` ноль сначала попадает в ранний clamp `n_batch = n_ubatch = 0`, после чего создание контекста завершается `n_batch and n_ubatch cannot both be zero`. Arriero требует для этих режимов явный положительный ubatch.

## Когда использовать

Уменьшайте `--ubatch-size`, если модель стартует, но падает или получает OOM именно при обработке длинного prompt. Это часто сохраняет логический `--batch-size` и throughput планировщика, но снижает пиковую память на один backend graph.

Увеличивайте осторожно, если GPU/CPU недогружены на prefill и есть явный запас памяти.

## Влияние на производительность и память

Меньший `--ubatch-size` снижает пиковую память и может стабилизировать запуск на ограниченной VRAM. Но слишком маленькое значение увеличивает число запусков графа, ухудшает prefill throughput и может поднять latency.

Большой `--ubatch-size` особенно чувствителен на больших моделях, длинном контексте и нескольких слотах.

## Взаимодействие с другими аргументами

- `--batch-size`: верхняя граница для `--ubatch-size`.
- `--ctx-size`: через фактический `n_batch` ограничивает и `n_ubatch`.
- `--parallel`: увеличивает число decode-токенов, которые сервер должен обслуживать за итерацию.
- `--cont-batching`: повышает шанс, что несколько prompt fragments попадут в общий batch.
- `--threads-batch`: влияет на CPU-параллелизм для batch phase.

## INI-пресеты и router-режим

В INI используется `ubatch-size = 512` или `LLAMA_ARG_UBATCH`. Этот аргумент входит в whitelist удаленных presets.

В router-режиме значение применяется к дочернему процессу конкретной модели.

## Типовые проблемы и диагностика

- Ошибка `input (...) is too large to process. increase the physical batch size` возникает для задач, которые нельзя split-ить; тогда `--ubatch-size` действительно должен быть не меньше входа.
- При OOM на prompt processing пробуйте `--ubatch-size 256` или `--ubatch-size 128`.
- В логах `llama-context` проверяйте фактические `n_batch` и `n_ubatch`.

## Примеры

```bash
llama-server --model /models/model.gguf --batch-size 2048 --ubatch-size 256
```

```bash
llama-server --model /models/embed.gguf --embedding --batch-size 512 --ubatch-size 512
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
