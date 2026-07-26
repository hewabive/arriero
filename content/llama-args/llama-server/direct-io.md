---
schema: 1
primaryName: "--direct-io"
title: "--direct-io"
summary: "Устаревшие boolean-флаги режима загрузки: `--direct-io` эквивалентен `--load-mode dio`, отрицательная форма — `--load-mode none`."
category: "Общие параметры"
valueType: "boolean"
valueHint: null
aliases:
  - "-dio"
  - "--direct-io"
  - "-ndio"
  - "--no-direct-io"
allowedValues: []
env:
  - "LLAMA_ARG_DIO"
related:
  - "--load-mode"
  - "--mmap"
  - "--mlock"
  - "--check-tensors"
---

# --direct-io

## Кратко

`--direct-io` и `--no-direct-io` оставлены для совместимости и помечены upstream как deprecated. Используйте `--load-mode dio` или `--load-mode none`.

## Оригинальная справка llama.cpp

```text
DEPRECATED in favor of `--load-mode`: use DirectIO if available
```

## Паспорт аргумента

- Основное имя: `--direct-io`
- Алиас: `-dio`
- Отрицательные формы: `-ndio`, `--no-direct-io`
- Статус: deprecated
- Замены: `--load-mode dio`, `--load-mode none`
- Переменная окружения: `LLAMA_ARG_DIO`
- Поля: `common_params::load_mode`, `llama_model_params::load_mode`

## Что меняет в llama-server

- `--direct-io` записывает `LLAMA_LOAD_MODE_DIRECT_IO`.
- `--no-direct-io` записывает `LLAMA_LOAD_MODE_NONE`.

В режиме `dio` loader открывает GGUF для Direct I/O и не использует mmap. Режим предназначен для обхода обычного page cache на поддерживаемых platform/filesystem/storage combinations.

Legacy-флаг всегда выводит deprecated warning. Новый единый enum устраняет прежнюю неоднозначную комбинацию Direct I/O с mmap.

## Миграция

```bash
# Было
llama-server --model /models/model.gguf --direct-io

# Стало
llama-server --model /models/model.gguf --load-mode dio
```

Не добавляйте `--no-mmap`: режим `dio` уже взаимоисключающий. Не смешивайте legacy-флаг с `--load-mode`, потому что последнее CLI-значение побеждает.

## Когда использовать режим dio

Тестируйте на больших моделях и быстрых NVMe/RAID, если важно не вытеснять другие данные из page cache. Не включайте как универсальную оптимизацию: результат зависит от alignment, filesystem, storage и backend upload path.

## Влияние на производительность и память

Direct I/O уменьшает участие page cache, но требует aligned reads и может оказаться медленнее mmap. Сравнивайте cold/warm startup и steady-state latency на одинаковой модели.

`--check-tensors` добавляет чтение/проверку данных и также может влиять на upload path, поэтому benchmark проводите отдельно с проверкой и без неё.

## Router-режим

В новых INI-presets:

```ini
load-mode = dio
```

Одновременная загрузка нескольких моделей может создать сильную нагрузку на storage.

## Типовые проблемы и диагностика

- Deprecated warning: замените флаг на `--load-mode dio`.
- Старт стал медленнее: сравните с `--load-mode mmap`.
- Ошибки чтения/alignment: filesystem или storage path не подходят для Direct I/O; вернитесь к `mmap`.
- Фактический режим виден в логе `loading model tensors ... (load_mode = dio)`.

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-model.cpp`
- https://github.com/ggml-org/llama.cpp/pull/20834
