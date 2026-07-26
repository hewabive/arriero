---
schema: 1
primaryName: "--load-mode"
title: "--load-mode"
summary: "Выбирает единый режим загрузки модели: обычное чтение, mmap, mmap с mlock или Direct I/O. Заменяет устаревшие `--mmap`, `--mlock` и `--direct-io`."
category: "Общие параметры"
valueType: "enum"
valueHint: "MODE"
aliases:
  - "-lm"
  - "--load-mode"
allowedValues:
  - "none"
  - "mmap"
  - "mlock"
  - "dio"
env:
  - "LLAMA_ARG_LOAD_MODE"
related:
  - "--mmap"
  - "--mlock"
  - "--direct-io"
  - "--check-tensors"
---

# --load-mode

## Кратко

`--load-mode` задаёт единое поле `common_params::load_mode`, которое передаётся в `llama_model_params::load_mode`. По умолчанию используется `mmap`.

Этот аргумент заменяет три независимых legacy-флага загрузки. Режимы теперь взаимоисключающие, поэтому конфигурация не может одновременно просить mmap, mlock и Direct I/O.

## Оригинальная справка llama.cpp

```text
model loading mode (default: mmap)
- none: no special loading mode
- mmap: memory-map model (if mmap disabled, slower load but may reduce pageouts if not using mlock)
- mlock: mmap + force system to keep model in RAM rather than swapping or compressing
- dio: use DirectIO if available
```

## Паспорт аргумента

- Основное имя: `--load-mode`
- Короткий алиас: `-lm`
- Допустимые значения: `none`, `mmap`, `mlock`, `dio`
- Переменная окружения: `LLAMA_ARG_LOAD_MODE`
- Поля: `common_params::load_mode`, `llama_model_params::load_mode`
- Значение по умолчанию: `mmap`
- Этап применения: открытие GGUF и загрузка тензоров

## Режимы

- `none`: обычное чтение данных в buffers без mmap, mlock и Direct I/O.
- `mmap`: memory-map GGUF; стандартный режим и обычно самый быстрый старт.
- `mlock`: mmap плюс попытка удерживать mapped pages в RAM, не допуская swap/compression.
- `dio`: Direct I/O, если его поддерживают платформа, filesystem и файл.

Loader выводит фактический выбор строкой `loading model tensors ... (load_mode = ...)`.

## Когда использовать

Оставляйте `mmap` как baseline. `none` полезен при диагностике page-cache/mmap проблем. `mlock` выбирайте для долгоживущего процесса с достаточным лимитом locked memory. `dio` тестируйте на быстрых хранилищах, когда важно не загрязнять page cache.

## Влияние на производительность и память

`mmap` использует page cache ОС и ускоряет старт. `none` выполняет явное чтение и обычно загружается медленнее. `mlock` повышает предсказуемость latency ценой недоступной для вытеснения RAM. `dio` обходит обычный page cache, но эффективность зависит от storage и alignment.

## Совместимость с legacy-флагами

`--mlock`, `--mmap`/`--no-mmap` и `--direct-io`/`--no-direct-io` остаются временными deprecated-алиасами, которые также меняют `load_mode`. Не смешивайте их с `--load-mode`: llama.cpp выводит warning, а последнее встретившееся CLI-значение побеждает.

## INI-пресеты и router-режим

В INI:

```ini
load-mode = mmap
```

Для router-а задавайте режим per model, если разные модели находятся на хранилищах с разными характеристиками. `mlock` нужно планировать с учётом суммарной RAM всех одновременно загруженных моделей.

## Типовые проблемы и диагностика

- `invalid value`: передано значение вне `none|mmap|mlock|dio`.
- Warning о смешивании legacy-флагов: оставьте только `--load-mode`.
- Warning/error при `mlock`: проверьте `ulimit -l`, systemd `LimitMEMLOCK` и container capabilities.
- `dio` не даёт ускорения: сравните время загрузки с `mmap`; Direct I/O не является универсальной оптимизацией.

## Примеры

```bash
llama-server --model /models/model.gguf --load-mode mmap
llama-server --model /models/model.gguf --load-mode mlock
llama-server --model /models/model.gguf --load-mode dio
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-model.cpp`
- https://github.com/ggml-org/llama.cpp/pull/20834
