---
schema: 1
primaryName: "--op-offload"
title: "--op-offload"
summary: "Включает или отключает перенос host tensor operations на устройство в scheduler. По умолчанию включено; `--no-op-offload` оставляет такие операции на host."
category: "Общие параметры"
valueType: "boolean"
valueHint: null
aliases:
  - "--op-offload"
  - "--no-op-offload"
allowedValues: []
env: []
related:
  - "--device"
  - "--gpu-layers"
  - "--split-mode"
---

# --op-offload

## Кратко

`--op-offload` управляет флагом scheduler, который разрешает offload операций над host tensors на устройство. Дефолт текущего llama.cpp - включено; отрицательная форма `--no-op-offload` отключает это поведение.

## Оригинальная справка llama.cpp

```text
whether to offload host tensor operations to device (default: true)
```

## Паспорт аргумента

- Основное имя: `--op-offload`
- Алиасы: `--op-offload`, `--no-op-offload`
- Переменная окружения: не задана в `arg.cpp`
- Поле `common_params`: `no_op_offload`
- Поле `llama_context_params`: `op_offload`
- Значение по умолчанию: `true`
- Этап применения: создание context и scheduler

## Что меняет в llama-server

Парсер bool-аргумента записывает инвертированное значение: `--op-offload` делает `params.no_op_offload = false`, `--no-op-offload` делает `true`. При преобразовании в `llama_context_params` это превращается в `op_offload`.

Флаг передается в `ggml_backend_sched_new()`. Он не меняет размещение весов модели и не влияет на `llama_model_params`.

## Значения и формат

CLI использует две формы без отдельного значения: `--op-offload` и `--no-op-offload`. В проверенном commit env-переменная для этого аргумента не подключена.

## Когда использовать

Оставляйте дефолт, если нет проблем с backend scheduler. Отключайте `--no-op-offload` для диагностики неправильных результатов, падений в backend kernel или нестабильности на конкретном ускорителе.

## Влияние на производительность и память

Включенный offload может уменьшить CPU-работу и лишние копирования, но конкретный эффект зависит от backend и графа вычислений. Важно: при видимом GPU он влияет и на размещение compute buffers даже при `--gpu-layers 0`. На CUDA b10276 для stories15M (ctx 4096) default разместил 72 MiB compute на GPU и 6 MiB на host, а `--no-op-offload` дал 0 MiB на GPU и 63 MiB на host. При полном offload весов breakdown в этой проверке не изменился.

Arriero учитывает этот перенос: CPU-веса не означают нулевую VRAM, пока доступен GPU и не задан `--no-op-offload`.

Параметр общий и наследуется вторым context: отдельной draft-моделью и built-in MTP. Поэтому `--no-op-offload` должен переносить на host не только compute target-модели, но и compute draft/MTP при их CPU placement; оценщик повторяет это наследование.

## Взаимодействие с другими аргументами

`--gpu-layers`, `--device` и `--split-mode` определяют, какие backends участвуют в модели; `--op-offload` влияет уже на scheduler операций в context.

Даже если веса не offload-ятся, наличие GPU backend достаточно для переноса host tensor operations. Чтобы получить действительно host-only footprint при видимом GPU, сочетайте `--gpu-layers 0` с `--no-op-offload` (и отдельно учитывайте mmproj/draft adapters).

## INI-пресеты и router-режим

В INI для включения:

```ini
op-offload = true
```

Для отключения используйте отрицательный ключ, как рекомендует README для boolean-флагов:

```ini
no-op-offload = true
```

В router-режиме это обычный модельный параметр и может задаваться в preset конкретной модели.

## Типовые проблемы и диагностика

- Падение только на GPU backend: повторите запуск с `--no-op-offload`.
- Нет разницы в скорости: сравните `CUDA* compute buffer size` и `Host compute buffer size`; весовой offload может быть нулевым, хотя operation offload активен.
- Аргумент из env не работает: для этого аргумента в проверенном `arg.cpp` не задан `.set_env()`.

## Примеры

```bash
llama-server --model /models/model.gguf --op-offload
```

```bash
llama-server --model /models/model.gguf --no-op-offload
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/ggml/src/ggml-backend.cpp`
- `llama.cpp/tools/server/README.md`
