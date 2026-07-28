---
schema: 1
primaryName: "--mmap"
title: "--mmap"
summary: "Устаревшие boolean-флаги режима загрузки: `--mmap` эквивалентен `--load-mode mmap`, а `--no-mmap` — `--load-mode none`."
category: "Общие параметры"
valueType: "boolean"
valueHint: null
aliases:
  - "--mmap"
  - "--no-mmap"
allowedValues: []
env:
  - "LLAMA_ARG_MMAP"
related:
  - "--load-mode"
  - "--mlock"
  - "--direct-io"
---

# --mmap

## Кратко

`--mmap` и `--no-mmap` оставлены для совместимости и помечены upstream как deprecated. В новых конфигурациях используйте `--load-mode mmap` или `--load-mode none`.

Обе формы меняют единое поле `common_params::load_mode`; отдельных `use_mmap`/`use_mlock`/`use_direct_io` в `common_params` больше нет.

## Оригинальная справка llama.cpp

```text
DEPRECATED in favor of `--load-mode`: whether to memory-map model. (if mmap disabled, slower load but may reduce pageouts if not using mlock)
```

## Паспорт аргумента

- Основное имя: `--mmap`
- Отрицательная форма: `--no-mmap`
- Статус: deprecated
- Замены: `--load-mode mmap`, `--load-mode none`
- Переменная окружения: `LLAMA_ARG_MMAP`
- Поля: `common_params::load_mode`, `llama_model_params::load_mode`
- Общий default режима загрузки: `mmap`

## Что меняет в llama-server

- `--mmap` записывает `LLAMA_LOAD_MODE_MMAP`.
- `--no-mmap` записывает `LLAMA_LOAD_MODE_NONE`.

В режиме `mmap` loader memory-map-ит GGUF и использует page cache ОС. В режиме `none` данные читаются в buffers обычным путём; загрузка обычно медленнее, но при некоторых memory-pressure сценариях уменьшаются pageouts.

Обе legacy-формы выводят deprecated warning.

## Миграция

```bash
# Было
llama-server --model /models/model.gguf --mmap
llama-server --model /models/model.gguf --no-mmap

# Стало
llama-server --model /models/model.gguf --load-mode mmap
llama-server --model /models/model.gguf --load-mode none
```

Не смешивайте старые формы с `--load-mode`: последнее CLI-значение побеждает.

## Влияние на производительность и память

`mmap` обычно ускоряет старт и позволяет ОС лениво подгружать страницы. `none` увеличивает объём явного чтения, но может дать более предсказуемое поведение на filesystem, где mmap работает плохо.

Для удержания mapped pages в RAM используйте `--load-mode mmap+mlock`; режим `--load-mode mlock` mmap не включает и читает модель в анонимные host-буферы. Для обхода page cache — `--load-mode dio`.

## Router-режим

В новых INI-presets:

```ini
load-mode = mmap
```

или:

```ini
load-mode = none
```

## Типовые проблемы и диагностика

- Deprecated warning: замените флаг на `--load-mode`.
- Медленный старт с `none`: ожидаемая цена обычного чтения.
- Pageouts с `mmap`: сравните `none` и `mmap+mlock`, контролируя одинаковую нагрузку.
- Фактический режим виден в логе `loading model tensors ... (load_mode = mmap|none)`.

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-model.cpp`
- https://github.com/ggml-org/llama.cpp/pull/20834
