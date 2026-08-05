---
schema: 1
primaryName: "--kv-offload"
title: "--kv-offload"
summary: "Управляет offload KV/KQV операций и буферов на device backend. По умолчанию включено; `--no-kv-offload` оставляет их на host."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "-kvo"
  - "--kv-offload"
  - "-nkvo"
  - "--no-kv-offload"
allowedValues: []
env:
  - "LLAMA_ARG_KV_OFFLOAD"
related:
  - "--cache-type-k"
  - "--cache-type-v"
  - "--ctx-size"
  - "--gpu-layers"
  - "--device"
---

# --kv-offload

## Кратко

`--kv-offload` управляет `common_params::no_kv_offload`; в `llama_context_params` это превращается в `offload_kqv = !no_kv_offload`.

По умолчанию offload включен. Для выключения используйте `--no-kv-offload` или `-nkvo`.

## Оригинальная справка llama.cpp

```text
whether to enable KV cache offloading (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--kv-offload`
- Алиасы включения: `-kvo`, `--kv-offload`
- Алиасы выключения: `-nkvo`, `--no-kv-offload`
- Значение по умолчанию: enabled
- Переменная окружения: `LLAMA_ARG_KV_OFFLOAD`
- Поля llama.cpp: `common_params::no_kv_offload`, `llama_context_params::offload_kqv`
- Этап применения: создание context/backend buffers

## Что меняет в llama-server

При включенном режиме backend может размещать KV/KQV связанные buffers и операции на device. При выключенном режиме они остаются на host, что снижает VRAM usage, но обычно ухудшает скорость при GPU-инференсе.

Фактическое размещение также зависит от backend, `--device`, `--gpu-layers`, split-mode и доступной памяти.

## Значения и формат

CLI-форма флаговая:

- `--kv-offload`: включить.
- `--no-kv-offload`: выключить.

Через окружение: `LLAMA_ARG_KV_OFFLOAD=true` (также `1`, `on`, `enabled`) включает, `false` (также `0`, `off`, `disabled`) выключает.

## Когда использовать

Оставляйте включенным для GPU-сервера, если KV помещается в VRAM. Выключайте при VRAM OOM, если готовы платить latency/throughput, или для диагностики различий CPU/GPU KV.

## Влияние на производительность и память

Включение обычно ускоряет attention path, но увеличивает device memory. Выключение переносит давление в RAM и шину CPU/GPU, поэтому длинный контекст и много слотов могут стать заметно медленнее.

На multi-GPU с layer split выключение бьет еще и по pipeline parallelism: условие его включения в `llama-context` требует `cparams.offload_kqv`, так что `--no-kv-offload` отключает pipeline parallel целиком.

## Взаимодействие с другими аргументами

- `--ctx-size`, `--parallel`, `--kv-unified`: определяют объем KV.
- `--cache-type-k` и `--cache-type-v`: уменьшают/увеличивают размер KV.
- `--gpu-layers`, `--device`, `--tensor-split`, `--split-mode`: влияют на backend placement.
- `--no-host`: отдельный параметр host buffer bypass, не заменяет `--no-kv-offload`.

## INI-пресеты и router-режим

В INI используйте `kv-offload = true` или `no-kv-offload = true`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- При VRAM OOM сравните `--no-kv-offload` и/или квантованные `--cache-type-*`.
- В логах backend/KV смотрите размеры KV buffers и имя backend buffer.
- Если скорость резко упала после выключения, это ожидаемая цена host KV.
- Известный дефект: авторазрешение `--flash-attn auto` работает некорректно в сочетании с `--no-kv-offload` (в `llama-context` есть FIXME `fa_device_mismatch logic is wrong for --no-kv-offload`); при странных решениях auto задавайте `--flash-attn on`/`off` явно.

## Примеры

```bash
llama-server --model /models/model.gguf --kv-offload
```

```bash
llama-server --model /models/model.gguf --no-kv-offload --cache-type-k q8_0 --cache-type-v q8_0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
