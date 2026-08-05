---
schema: 1
primaryName: "--mlock"
title: "--mlock"
summary: "Устаревший флаг, эквивалентный `--load-mode mlock`: читает модель без mmap и удерживает её в RAM без swap или memory compression."
category: "Общие параметры"
valueType: "flag"
estimation: "normal"
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

Legacy-флаг выставляет единое поле `common_params::load_mode = LLAMA_LOAD_MODE_MLOCK`, а не отдельный boolean. Начиная с llama.cpp #26135 этот режим mmap **не** включает: модель читается обычным чтением в host-буферы, а mlock применяется уже к ним.

## Оригинальная справка llama.cpp

```text
DEPRECATED in favor of `--load-mode`: force system to keep model in RAM rather than swapping or compressing
```

## Паспорт аргумента

- Основное имя: `--mlock`
- Статус: deprecated
- Замена: `--load-mode mlock`
- Переменная окружения: `LLAMA_ARG_MLOCK`
- Поля: `common_params::load_mode`, `llama_model_params::load_mode`
- Результирующий режим: `LLAMA_LOAD_MODE_MLOCK`

## Что меняет в llama-server

При разборе флага llama.cpp пишет warning `--mlock is deprecated. use --load-mode mlock instead`. Loader читает тензоры без mmap, а `llama-model.cpp` вызывает mlock для host backend buffers.

Режим не уменьшает потребление RAM. Он делает страницы менее доступными для вытеснения и может стабилизировать latency после простоя, но повышает риск memory pressure для остальных процессов. Без mmap старт медленнее, чем в default-режиме: файл читается целиком, а не подгружается страницами по мере обращения.

## Изменение семантики в llama.cpp #26135

Раньше `--mlock` означал mmap плюс mlock. После #26135 он означает mlock без mmap, а прежнее поведение доступно только как отдельное значение `--load-mode mmap+mlock`.

Практическое следствие: инстанс, который годами запускался с `--mlock`, после обновления бинарника стартует заметно дольше и держит модель как анонимную RSS-копию вместо разделяемых с page cache страниц файла. Если целью было именно «быстрый mmap-старт плюс защита от вытеснения», переключитесь на `--load-mode mmap+mlock`.

Учтите обратную совместимость: сборки старее #26135 не понимают значение `mmap+mlock` и падают с `invalid value`.

## Миграция

Замените:

```bash
llama-server --model /models/model.gguf --mlock
```

на:

```bash
llama-server --model /models/model.gguf --load-mode mlock
```

Это точный эквивалент по поведению. Если же нужен прежний, до-#26135 смысл флага, целевое значение другое:

```bash
llama-server --model /models/model.gguf --load-mode mmap+mlock
```

Не комбинируйте legacy-флаг с `--load-mode`: parser выдаёт отдельный warning, а последнее CLI-значение побеждает.

## Когда использовать режим mlock

Используйте на долгоживущем сервере, если модель частично находится в host RAM и наблюдаются page faults, swap или latency spikes. Сначала проверьте запас RAM и лимит locked memory.

Выбор между `mlock` и `mmap+mlock` сводится к тому, нужен ли быстрый старт и разделяемая с page cache память. Для обычного локального GGUF почти всегда лучше `mmap+mlock`; чистый `mlock` оправдан, когда файл не должен оставаться в критическом пути после загрузки.

На полностью GPU-resident модели эффект обычно меньше, хотя host buffers и CPU fallback всё ещё могут участвовать.

## Router-режим

В новых INI-presets используйте:

```ini
load-mode = mlock
```

или, если нужен mmap вместе с блокировкой:

```ini
load-mode = mmap+mlock
```

Планируйте суммарный locked memory всех одновременно загруженных моделей.

## Типовые проблемы и диагностика

- Deprecated warning: мигрируйте на `--load-mode mlock`.
- Warning/error про lock memory: проверьте `ulimit -l`, systemd `LimitMEMLOCK` и container capabilities.
- Система начинает swap-ить другие процессы: вернитесь к `--load-mode mmap` или уменьшите число моделей.
- Старт стал медленнее после обновления бинарника: это ожидаемый эффект #26135 — режим больше не использует mmap; переключитесь на `--load-mode mmap+mlock`.
- Фактический режим виден в логе `loading model tensors ... (load_mode = mlock)`.

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-model.cpp`
- https://github.com/ggml-org/llama.cpp/pull/20834
- https://github.com/ggml-org/llama.cpp/pull/26135
