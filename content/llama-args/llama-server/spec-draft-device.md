---
schema: 1
primaryName: "--spec-draft-device"
title: "--spec-draft-device"
summary: "Ограничивает список backend-устройств для offload draft-модели. Значение `none` отключает offload draft-модели независимо от устройств target-модели."
category: "Параметры speculative decoding"
valueType: "list"
estimation: "normal"
valueHint: "<dev1,dev2,..>"
aliases:
  - "--spec-draft-device"
  - "-devd"
  - "--device-draft"
allowedValues: []
env: []
related:
  - "--device"
  - "--list-devices"
  - "--spec-draft-ngl"
  - "--spec-draft-model"
  - "--spec-draft-override-tensor"
---

# --spec-draft-device

## Кратко

`--spec-draft-device` задает список GPU/backend устройств для draft-модели. Значение парсится через `parse_device_list()` и записывается в `common_params.speculative.draft.devices`; при загрузке draft-модели сервер копирует его в `params_dft.devices`.

Если параметр не задан, используется default-выбор устройств llama.cpp. Если задано `none`, в список помещается `nullptr`, что означает "не offload".

## Оригинальная справка llama.cpp

```text
comma-separated list of devices to use for offloading the draft model (none = don't offload)
use --list-devices to see a list of available devices
```

## Паспорт аргумента

- Основное имя: `--spec-draft-device`
- Алиасы: `--spec-draft-device`, `-devd`, `--device-draft`
- Значение: список имен устройств через запятую или `none`
- Структура llama.cpp: `common_params.speculative.draft.devices`
- Переменная окружения: нет
- Этап применения: парсинг CLI и загрузка draft-модели

## Что меняет в llama-server

Параметр влияет только на draft-модель. Target-модель продолжает использовать `--device`. В `server-context.cpp` для draft создается `params_dft`, где `devices` заменяется на draft-список, а затем модель загружается с этими настройками.

Парсер загружает все backend-регистры, ищет устройство по имени через `ggml_backend_dev_by_name()` и отвергает CPU-устройства как invalid device. В конце обычного списка добавляется `nullptr` sentinel.

## Значения и формат

Имена устройств берите из `llama-server --list-devices`. Формат - строго через запятую без shell-склейки, например `CUDA0,CUDA1`. Значение `none` должно быть единственным элементом.

Пустой список вызывает `no devices specified`. Неизвестное имя или CPU device вызывает `invalid device: ...`.

## Когда использовать

Используйте, когда target и draft нужно развести по разным GPU, или когда draft-модель должна остаться на CPU, чтобы не вытеснять target из VRAM. На мног GPU это позволяет держать target на основном устройстве, а маленькую draft-модель на менее загруженном.

## Влияние на производительность и память

Выбор устройства меняет VRAM footprint и latency draft-предсказания. Draft на отдельном GPU может разгрузить target GPU, но добавляет межустройственное планирование и зависит от backend. `none` экономит VRAM, но может сделать draft медленнее и снизить общий выигрыш speculative decoding.

## Взаимодействие с другими аргументами

`--spec-draft-ngl` задает, сколько слоев draft-модели можно offload на выбранные устройства. `--spec-draft-override-tensor` может направить отдельные tensor в конкретный buffer type. `--device` для target-модели не наследуется автоматически, если `--spec-draft-device` задан явно.

## INI-пресеты и router-режим

В INI используйте `device-draft = none` или `spec-draft-device = CUDA0`. Для переносимых preset не зашивайте имена устройств без проверки `--list-devices` на целевом сервере.

## Типовые проблемы и диагностика

- `invalid device`: имя не совпадает с `--list-devices` или указывает на CPU.
- Draft все равно занимает VRAM target GPU: проверьте, не задан ли `--spec-draft-ngl all` без нужного `--spec-draft-device`.
- Нет ускорения после переноса draft на другой GPU: смотрите `draft acceptance`, backend-логи и загрузку PCIe/NVLink.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-device none
```

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-device CUDA1 --spec-draft-ngl all
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
