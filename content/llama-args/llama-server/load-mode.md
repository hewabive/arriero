---
schema: 1
primaryName: "--load-mode"
title: "--load-mode"
summary: "Выбирает единый режим загрузки модели: обычное чтение, mmap, mlock без mmap, mmap с mlock или Direct I/O. Заменяет устаревшие `--mmap`, `--mlock` и `--direct-io`."
category: "Общие параметры"
valueType: "enum"
estimation: "normal"
valueHint: "MODE"
aliases:
  - "-lm"
  - "--load-mode"
allowedValues:
  - "none"
  - "mmap"
  - "mlock"
  - "mmap+mlock"
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
- mlock: force system to keep model in RAM rather than swapping or compressing
- mmap+mlock: mmap + force system to keep model in RAM rather than swapping or compressing
- dio: use DirectIO if available
```

## Паспорт аргумента

- Основное имя: `--load-mode`
- Короткий алиас: `-lm`
- Допустимые значения: `none`, `mmap`, `mlock`, `mmap+mlock`, `dio`
- Переменная окружения: `LLAMA_ARG_LOAD_MODE`
- Поля: `common_params::load_mode`, `llama_model_params::load_mode`
- Значение по умолчанию: `mmap`
- Этап применения: открытие GGUF и загрузка тензоров

## Режимы

- `none`: обычное чтение данных в buffers без mmap, mlock и Direct I/O.
- `mmap`: memory-map GGUF; стандартный режим и обычно самый быстрый старт.
- `mlock`: обычное чтение без mmap плюс mlock host-буферов модели. Страницы удерживаются в RAM, но это анонимная копия, не разделяемая с page cache.
- `mmap+mlock`: mmap плюс mlock самих mapped pages (и host-буферов). До llama.cpp #26135 это поведение называлось просто `mlock`.
- `dio`: Direct I/O, если его поддерживают платформа, filesystem и файл.

Loader выводит фактический выбор строкой `loading model tensors ... (load_mode = ...)`.

mlock применяется в двух местах: `llama-model.cpp` блокирует host backend buffers (`ggml_backend_buffer_is_host`), а `init_mappings` дополнительно блокирует mapping — последнее возможно только когда mmap реально включён, то есть в режиме `mmap+mlock`.

## Когда использовать

Оставляйте `mmap` как baseline. `none` полезен при диагностике page-cache/mmap проблем. `mmap+mlock` — обычный выбор для долгоживущего процесса с достаточным лимитом locked memory: быстрый старт плюс защита от вытеснения. Чистый `mlock` берите, когда модель должна жить в анонимной памяти независимо от файла и page cache (например, файл лежит на сетевом или медленном хранилище, которое не хочется держать в критическом пути). `dio` тестируйте на быстрых хранилищах, когда важно не загрязнять page cache.

## Влияние на производительность и память

`mmap` использует page cache ОС и ускоряет старт. `none` выполняет явное чтение и обычно загружается медленнее. `mmap+mlock` сохраняет быстрый старт mmap и повышает предсказуемость latency ценой недоступной для вытеснения RAM. Чистый `mlock` наследует медленный старт `none` (полное чтение вместо ленивой подгрузки страниц) и держит модель как анонимную RSS-копию: при нескольких процессах на одном GGUF память не разделяется, в отличие от `mmap+mlock`. `dio` обходит обычный page cache, но эффективность зависит от storage и alignment.

Arriero сохраняет одинаковую логическую сумму tensor bytes для этих режимов и выводит предупреждение: разница проявляется в RSS, reclaimability, sharing и locked memory, то есть требует process-level измерения, а не другой GGUF-формулы.

## Совместимость с legacy-флагами

`--mlock`, `--mmap`/`--no-mmap` и `--direct-io`/`--no-direct-io` остаются временными deprecated-алиасами, которые также меняют `load_mode`. Не смешивайте их с `--load-mode`: llama.cpp выводит warning, а последнее встретившееся CLI-значение побеждает.

`--mlock` теперь выставляет режим `mlock`, то есть mlock без mmap. Прежнего эквивалента у legacy-флага нет — для старого поведения нужен явный `--load-mode mmap+mlock`.

## Изменение семантики в llama.cpp #26135

До этого коммита значение `mlock` означало mmap плюс mlock. После него `mlock` — это mlock без mmap, а прежнее поведение переехало в новое значение `mmap+mlock`.

Это тихое изменение поведения для уже существующих конфигураций: инстанс или INI-пресет с `load-mode = mlock` (или с legacy `--mlock`) после обновления бинарника получит полное чтение файла вместо mmap — заметно более медленный старт и анонимную копию модели в RSS. Если нужно прежнее поведение, поменяйте значение на `mmap+mlock` явно.

Обратной совместимости у нового значения нет: бинарник, собранный до #26135, на `--load-mode mmap+mlock` завершится с `invalid value`. Пока в path-catalog остаются сборки старее этого коммита, не ставьте `mmap+mlock` в пресеты и defaults, которые могут быть запущены на них.

## INI-пресеты и router-режим

В INI:

```ini
load-mode = mmap
```

Для router-а задавайте режим per model, если разные модели находятся на хранилищах с разными характеристиками. `mlock` и `mmap+mlock` нужно планировать с учётом суммарной RAM всех одновременно загруженных моделей.

## Типовые проблемы и диагностика

- `invalid value`: передано значение вне `none|mmap|mlock|mmap+mlock|dio` либо бинарник старее #26135 и не знает `mmap+mlock`.
- Warning о смешивании legacy-флагов: оставьте только `--load-mode`.
- Warning/error при `mlock` и `mmap+mlock`: проверьте `ulimit -l`, systemd `LimitMEMLOCK` и container capabilities.
- Старт неожиданно замедлился после обновления llama.cpp: проверьте, не остался ли в конфиге `load-mode = mlock`, который теперь не включает mmap.
- `dio` не даёт ускорения: сравните время загрузки с `mmap`; Direct I/O не является универсальной оптимизацией.

## Примеры

```bash
llama-server --model /models/model.gguf --load-mode mmap
llama-server --model /models/model.gguf --load-mode mlock
llama-server --model /models/model.gguf --load-mode mmap+mlock
llama-server --model /models/model.gguf --load-mode dio
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-model.cpp`
- https://github.com/ggml-org/llama.cpp/pull/20834
- https://github.com/ggml-org/llama.cpp/pull/26135
