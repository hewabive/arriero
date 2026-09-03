---
schema: 1
primaryName: "--lazy-mode"
title: "--lazy-mode"
summary: "Управляет чтением по требованию специально помеченных крупных tensors вместо их предварительного удержания в RAM. `auto` включает режим только для tensor больше 4 GiB, а `on` — для всех поддержанных архитектурой tensors."
category: "Общие параметры"
valueType: "enum"
estimation: "normal"
valueHint: "MODE"
aliases:
  - "-lzm"
  - "--lazy-mode"
allowedValues:
  - "on"
  - "auto"
  - "off"
env:
  - "LLAMA_ARG_LAZY_MODE"
related:
  - "--load-mode"
  - "--mlock"
  - "--check-tensors"
---

# --lazy-mode

## Кратко

`--lazy-mode` оставляет специально помеченные архитектурой tensors в mmap и подгружает нужные rows по page fault по мере обращения. Основной сценарий — очень большие per-layer embeddings/PLE tables, из которых конкретный forward читает лишь небольшую часть.

По умолчанию `auto` применяет lazy read только к помеченному tensor строго больше 4 GiB. Режим не делает ленивыми все weights модели.

## Оригинальная справка llama.cpp

```text
on-demand reading of certain tensors, for example per-layer embeddings (default: auto)
- on: read the rows of such tensors from disk on demand instead of keeping them resident (requires mmap)
- auto: on, but only for tensors larger than 4 GiB
- off: always keep them resident
```

## Паспорт аргумента

- Основное имя: `--lazy-mode`
- Алиас: `-lzm`
- Значения: `on`, `auto`, `off`
- Переменная окружения: `LLAMA_ARG_LAZY_MODE`
- Поля: `common_params::lazy_mode`, `llama_model_params::lazy_mode`
- Значение по умолчанию: `auto`
- Этап применения: построение tensor buffers и mmap ranges при загрузке GGUF

## Что меняет в llama-server

Lazy read рассматривает только tensors, созданные модельной архитектурой с флагом `TENSOR_READ_LAZY`. В текущем checkout это per-layer token embeddings Gemma 4 и PLE embedding Qwen4 experimental; обычные attention/FFN weights режим не затрагивает.

Выбранные tensors получают отдельный CPU buffer и mmap ranges, исключённые из предварительного prefetch. Loader не применяет к ним GPU offload и не mlock-ит их, поскольку оба действия немедленно сделали бы данные resident. При обращении backend читает нужные rows из mapping.

## Значения и формат

- `auto`: lazy read только для помеченных tensors размером больше 4 GiB.
- `on`: lazy read каждого помеченного tensor независимо от размера.
- `off`: всегда загружать помеченные tensors целиком обычным способом.

Любое другое значение завершает разбор с `invalid value`. Наличие поддержки mmap на платформе обязательно: если её нет, loader пишет warning и загружает tensor в RAM полностью.

## Когда использовать

Оставляйте `auto`, если модель содержит гигантские row-addressable embeddings: это избегает значительной resident RAM при умеренном overhead. `on` полезен для измерения экономии на tensors меньше 4 GiB или на хосте с жёстким RAM budget. `off` нужен для предсказуемой latency без disk page faults и для сравнения производительности.

На медленном или сетевом storage сначала измерьте tail latency: случайное чтение rows может оказаться дороже полной загрузки.

## Влияние на производительность и память

Lazy mode уменьшает resident RAM, пока workload обращается лишь к части rows. GGUF всё равно отображается в адресное пространство, а реально прочитанные страницы попадают в page cache. Первый доступ к новой row может дать I/O latency; повторные обращения выигрывают от cache ОС.

`on` для небольших tensors способен ухудшить производительность без заметной экономии — именно поэтому `auto` использует порог 4 GiB. Lazy tensors остаются на CPU, так что режим может также изменить стоимость обмена с GPU для поддерживаемой архитектуры.

## Взаимодействие с другими аргументами

- `--load-mode`: lazy tensors требуют mmap support. Loader создаёт mapping для их ranges даже если общий режим загрузки не использует mmap; остальные tensors продолжают подчиняться `--load-mode`.
- `--mlock`/`--load-mode mmap+mlock`: lazy ranges намеренно не блокируются в RAM.
- `--check-tensors`: полная проверка данных читает tensor bytes и может прогреть значительную часть mapping, временно лишив lazy load ожидаемой экономии старта.
- `--gpu-layers` и tensor overrides не offload-ят lazy tensor: loader принудительно собирает его на host.

## INI-пресеты и router-режим

```ini
[large-embedding-model]
lazy-mode = auto
```

Настройку следует держать per model: у архитектуры без `TENSOR_READ_LAZY` она не оказывает эффекта.

## Типовые проблемы и диагностика

- `invalid value`: допустимы только `on`, `auto`, `off`.
- `mmap is not available ... loaded into RAM in full`: сборка или платформа не поддерживает mapping.
- Нет экономии RAM: модель не помечает ни одного tensor либо в `auto` их размер не превышает 4 GiB.
- Первый запрос заметно медленнее: страницы читаются с диска по требованию; сравните `off` и более быстрое локальное storage.
- Активация подтверждается строкой `tensor ... lazy read enabled` с размером tensor.

## Примеры

```bash
llama-server --model /models/model.gguf --lazy-mode auto
llama-server --model /models/model.gguf --lazy-mode on
llama-server --model /models/model.gguf --lazy-mode off
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-mmap.cpp`
- `llama.cpp/src/models/gemma4.cpp`
- `llama.cpp/src/models/qwen4exp.cpp`
- https://github.com/ggml-org/llama.cpp/pull/27794
- https://github.com/ggml-org/llama.cpp/pull/27969
