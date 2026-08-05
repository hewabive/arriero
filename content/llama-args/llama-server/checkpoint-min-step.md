---
schema: 1
primaryName: "--checkpoint-min-step"
title: "--checkpoint-min-step"
summary: "Минимальное расстояние между context checkpoints в токенах. По умолчанию 8192; последний user turn и точки у конца prompt могут обходить этот интервал."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-cms"
  - "--checkpoint-min-step"
allowedValues: []
env:
  - "LLAMA_ARG_CHECKPOINT_MIN_SPACING_NT"
related:
  - "--ctx-checkpoints"
  - "--cache-ram"
  - "--cache-prompt"
---

# --checkpoint-min-step

## Кратко

`--checkpoint-min-step` задает `common_params::checkpoint_min_step`: минимальный разрыв в токенах между context checkpoints одного слота.

По умолчанию `8192`; `0` означает "без минимального разрыва".

## Оригинальная справка llama.cpp

```text
minimum spacing between context checkpoints in tokens (default: 8192, 0 = no minimum)
```

## Паспорт аргумента

- Основное имя: `--checkpoint-min-step`
- Алиасы: `-cms`, `--checkpoint-min-step`
- Значение по умолчанию: `8192`
- Переменная окружения: `LLAMA_ARG_CHECKPOINT_MIN_SPACING_NT`
- Поле llama.cpp: `common_params::checkpoint_min_step`
- Валидация: `value < 0` выбрасывает `checkpoint-min-step must be non-negative`

## Что меняет в llama-server

При prompt processing сервер распознаёт начала user messages по message spans. Для промежуточного user turn checkpoint создаётся, если его позиция дальше последнего checkpoint более чем на `checkpoint_min_step`. Для последнего user message и служебных точек около конца prompt (`4 + n_ubatch` и `4` токена до конца) spacing не блокирует создание.

При создании нового checkpoint сервер также просматривает сохранённые checkpoints от предыдущих задач и удаляет те, которые находятся в пределах min-step после более раннего checkpoint. Checkpoints текущей задачи этим проходом не удаляются.

На speculative checkpoints (`spec_ckpt`) min-step не действует — они создаются без проверки spacing.

Если `--ctx-checkpoints 0`, этот параметр фактически не используется.

## Значения и формат

- `0`: разрешить checkpoints без минимального интервала; из-за строгого сравнения `>` новая обычная точка всё равно должна идти после предыдущей.
- Положительное число: минимальный интервал в токенах.
- Отрицательное число: ошибка парсинга.

## Когда использовать

Уменьшайте, если длинная история содержит полезные промежуточные user boundaries и вы готовы хранить больше состояний. Увеличивайте, если checkpoints создаются слишком часто и RAM растёт. При дефолте `8192` сервер обычно сохраняет последний user boundary и точки у конца prompt, а более близкие промежуточные turns пропускает.

## Влияние на производительность и память

Меньшее значение создает больше checkpoints: больше RAM и overhead, но выше шанс быстрого восстановления. Большее значение экономит память, но может привести к повторной обработке большего prompt suffix.

## Взаимодействие с другими аргументами

- `--ctx-checkpoints`: включает/задает максимум checkpoints.
- `--cache-ram`: хранит prompt states и checkpoints в RAM.
- `--cache-prompt`: использует восстановленное состояние при reuse.

## INI-пресеты и router-режим

В INI используйте `checkpoint-min-step = 8192` или `LLAMA_ARG_CHECKPOINT_MIN_SPACING_NT`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- Ошибка запуска `checkpoint-min-step must be non-negative` означает отрицательное значение.
- Лог `context checkpoints enabled, max = ..., min spacing = ...` показывает фактический параметр.
- Логи `created context checkpoint` и `erasing old context checkpoint` помогают подобрать баланс.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-checkpoints 32 --checkpoint-min-step 2048
```

```bash
llama-server --model /models/model.gguf --ctx-checkpoints 16 --checkpoint-min-step 16384
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/20288
- https://github.com/ggml-org/llama.cpp/pull/24176
