---
schema: 1
primaryName: "--mlock"
title: "--mlock"
summary: "Устаревший флаг, эквивалентный `--load-mode mlock`: использует mmap и пытается удерживать модель в RAM без swap или memory compression."
category: "Общие параметры"
valueType: "flag"
valueHint: null
aliases:
  - "--mlock"
allowedValues: []
env:
  - "LLAMA_ARG_MLOCK"
related:
  - "--load-mode"
  - "--mmap"
  - "--direct-io"
---

# --mlock

## Кратко

`--mlock` оставлен для совместимости и помечен upstream как deprecated. Используйте `--load-mode mlock`.

Legacy-флаг выставляет единое поле `common_params::load_mode = LLAMA_LOAD_MODE_MLOCK`, а не отдельный boolean. Этот режим включает mmap и пытается закрепить mapped model pages в RAM.

## Оригинальная справка llama.cpp

```text
DEPRECATED in favor of `--load-mode`: mmap + force system to keep model in RAM rather than swapping or compressing
```

## Паспорт аргумента

- Основное имя: `--mlock`
- Статус: deprecated
- Замена: `--load-mode mlock`
- Переменная окружения: `LLAMA_ARG_MLOCK`
- Поля: `common_params::load_mode`, `llama_model_params::load_mode`
- Результирующий режим: `LLAMA_LOAD_MODE_MLOCK`

## Что меняет в llama-server

При разборе флага llama.cpp пишет warning `--mlock is deprecated. use --load-mode mlock instead`. Loader включает mmap, а `llama-model.cpp` активирует mlock для модельных данных.

Режим не уменьшает потребление RAM. Он делает страницы менее доступными для вытеснения и может стабилизировать latency после простоя, но повышает риск memory pressure для остальных процессов.

## Миграция

Замените:

```bash
llama-server --model /models/model.gguf --mlock
```

на:

```bash
llama-server --model /models/model.gguf --load-mode mlock
```

Не комбинируйте legacy-флаг с `--load-mode`: parser выдаёт отдельный warning, а последнее CLI-значение побеждает.

## Когда использовать режим mlock

Используйте на долгоживущем сервере, если модель частично находится в host RAM и наблюдаются page faults, swap или latency spikes. Сначала проверьте запас RAM и лимит locked memory.

На полностью GPU-resident модели эффект обычно меньше, хотя host buffers и CPU fallback всё ещё могут участвовать.

## Router-режим

В новых INI-presets используйте:

```ini
load-mode = mlock
```

Планируйте суммарный locked memory всех одновременно загруженных моделей.

## Типовые проблемы и диагностика

- Deprecated warning: мигрируйте на `--load-mode mlock`.
- Warning/error про lock memory: проверьте `ulimit -l`, systemd `LimitMEMLOCK` и container capabilities.
- Система начинает swap-ить другие процессы: вернитесь к `--load-mode mmap` или уменьшите число моделей.
- Фактический режим виден в логе `loading model tensors ... (load_mode = mlock)`.

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-model.cpp`
- https://github.com/ggml-org/llama.cpp/pull/20834
