---
schema: 1
primaryName: "--mmproj-device"
title: "--mmproj-device"
summary: "Выбирает ровно одно устройство для multimodal projector независимо от устройств основной модели. Значение `none` отключает projector offload, а незаданный флаг оставляет автоматический выбор GPU/iGPU."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "DEVICE"
aliases:
  - "-mmdev"
  - "--mmproj-device"
allowedValues: []
env:
  - "MTMD_BACKEND_DEVICE"
related:
  - "--mmproj"
  - "--mmproj-offload"
  - "--device"
  - "--list-devices"
---

# --mmproj-device

## Кратко

`--mmproj-device DEVICE` закрепляет multimodal projector за одним backend device. Это отдельный выбор от `--device`, который управляет основной text model, и полезен на multi-GPU хосте для разведения их памяти и нагрузки.

Если флаг не задан, mtmd выбирает первый доступный GPU, затем iGPU. Значение `none` переводит projector на CPU.

## Оригинальная справка llama.cpp

```text
device to use for multimodal projector (none = don't offload, default: auto)
use --list-devices to see a list of available devices
```

## Паспорт аргумента

- Основное имя: `--mmproj-device`
- Алиас: `-mmdev`
- Формат: имя устройства из `--list-devices` или `none`
- Переменная окружения: `MTMD_BACKEND_DEVICE`
- Поля: `common_params::mmproj_device`, `common_params::mmproj_use_gpu`
- Этап применения: инициализация backend-а при загрузке multimodal projector

## Что меняет в llama-server

Для имени устройства parser использует общий `parse_device_list`, но разрешает только один device. Выбранный `ggml_backend_dev_t` передаётся через `mtmd_context_params.device`; mtmd инициализирует именно этот backend и при неудаче прерывает загрузку вместо молчаливого fallback.

`none` записывает `mmproj_use_gpu = false` и пустой device, поэтому projector работает на CPU. Любое явное имя снова включает GPU offload.

## Значения и формат

- Не задано: auto, первый доступный GPU либо iGPU.
- `none`: не offload-ить projector.
- Одно имя из `llama-server --list-devices`: использовать конкретное устройство.
- Список из нескольких устройств отклоняется сообщением `only one device may be specified for mmproj`.

Переменная окружения намеренно называется `MTMD_BACKEND_DEVICE`, без префикса `LLAMA_ARG_`, ради обратной совместимости.

## Когда использовать

Задавайте device явно на multi-GPU системе, если projector должен жить не на той карте, где размещена основная модель, или если auto выбирает устройство с недостаточной памятью. `none` подходит для экономии VRAM и диагностики backend-проблем ценой более медленной multimodal обработки.

## Влияние на производительность и память

Projector weights и рабочие buffers занимают память выбранного устройства. Перенос на отдельную GPU меняет распределение VRAM, но не общий объём модели; перенос на CPU уменьшает VRAM и увеличивает RAM/CPU cost и latency кодирования media.

Флаг не перемещает основную LLM и её KV cache.

## Взаимодействие с другими аргументами

- `--mmproj`/`--mmproj-url` определяют сам projector; без него выбор устройства не используется.
- `--mmproj-offload` включает или выключает offload без выбора device. `--mmproj-device none` выключает его, а явное имя устройства включает.
- `--device` и `--gpu-layers` управляют основной text model отдельно.
- `--list-devices` показывает допустимые имена для текущей сборки, включая RPC devices после их регистрации.

## INI-пресеты и router-режим

```ini
[vision-model]
mmproj = /models/mmproj.gguf
mmproj-device = CUDA1
```

Держите настройку per model: разные projectors и child models могут требовать разного распределения GPU-памяти.

## Типовые проблемы и диагностика

- `only one device may be specified for mmproj`: передан CSV-список; оставьте одно имя.
- `failed to initialize "..." backend`: устройство известно, но backend не смог стартовать.
- `invalid device`: имя не совпадает с текущим `--list-devices` или нужный backend не собран/не зарегистрирован.
- VRAM используется не на той GPU: задайте точное имя из `--list-devices`, а не порядковый номер из другой конфигурации backend-ов.

## Примеры

```bash
llama-server --list-devices
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --mmproj-device CUDA1
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --mmproj-device none
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/mtmd/clip.cpp`
- `llama.cpp/tools/mtmd/mtmd.cpp`
- https://github.com/ggml-org/llama.cpp/pull/23255
