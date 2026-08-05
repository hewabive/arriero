---
schema: 1
primaryName: "--device"
title: "--device"
summary: "Ограничивает список не-CPU устройств, которые llama.cpp использует для offload. Значение `none` явно отключает offload на устройства."
category: "Общие параметры"
valueType: "list"
estimation: "normal"
valueHint: "<dev1,dev2,..>"
aliases:
  - "-dev"
  - "--device"
allowedValues: []
env:
  - "LLAMA_ARG_DEVICE"
related:
  - "--rpc"
  - "--gpu-layers"
  - "--list-devices"
  - "--main-gpu"
  - "--split-mode"
  - "--tensor-split"
---

# --device

## Кратко

`--device` задает явный список устройств для offload весов и связанных GPU-буферов. Это не индекс из `nvidia-smi`, а имя backend-устройства llama.cpp, например имя из вывода `--list-devices`.

Значение `none` создает пустой список устройств для модели и тем самым отключает offload на GPU/RPC-устройства.

## Оригинальная справка llama.cpp

```text
comma-separated list of devices to use for offloading (none = don't offload)
use --list-devices to see a list of available devices
```

## Паспорт аргумента

- Основное имя: `--device`
- Алиасы: `-dev`, `--device`
- Переменная окружения: `LLAMA_ARG_DEVICE`
- Поле `common_params`: `devices`
- Поле `llama_model_params`: `devices`, NULL-terminated список
- Разделитель: запятая
- Этап применения: парсинг CLI/env до загрузки модели

## Что меняет в llama-server

Парсер вызывает `parse_device_list()`: строка делится по запятым, каждый элемент ищется через `ggml_backend_dev_by_name()`, CPU-устройства отклоняются, затем в конец списка добавляется `nullptr` как терминатор для `llama_model_params::devices`.

Если `--device` не задан, llama.cpp сам строит список устройств: RPC-устройства идут первыми, затем дискретные GPU, а integrated GPU используются только если других GPU не найдено. При `--split-mode none` после этого остается только `--main-gpu`.

## Значения и формат

- `none`: не использовать offload-устройства.
- `CUDA0,CUDA1`, `Metal0`, `RPC0`: примеры формы, но точные имена зависят от сборки и backend.
- Пустое значение недопустимо: парсер выбрасывает `no devices specified`.
- CPU backend недопустим: парсер выбрасывает `invalid device`.

## Когда использовать

Используйте `--device`, когда на хосте несколько ускорителей и сервер должен занимать только часть из них. Это особенно важно в router-режиме, при параллельных инстансах или когда часть GPU зарезервирована под другой сервис.

`--device none` полезен для контрольного CPU-запуска, диагностики GPU-проблем и проверки, что падение связано именно с offload.

## Влияние на производительность и память

Ограничение списка устройств напрямую меняет доступную VRAM и распределение весов. Если оставить меньше GPU, `--fit auto` может перенести меньше слоев, снизить контекст или отказаться от подбора.

При явном списке порядок устройств важен для split-режимов и `--tensor-split`: пропорции применяются к устройствам в порядке списка.

Оценщик Arriero сейчас сопоставляет с локальными memory pools только имена
`CUDA<N>` и специальное значение `none`. Неизвестное имя, явный CPU backend или
CUDA index, которого нет после применения `CUDA_VISIBLE_DEVICES`, отклоняется:
его нельзя безопасно интерпретировать как host-only запуск. Другие локальные
backend-ы требуют собственного отображения pools и hardware qualification.

## Взаимодействие с другими аргументами

`--list-devices` нужен для получения точных имен устройств.

`--gpu-layers` определяет объем offload, а `--device` определяет, куда этот offload разрешен.

`--split-mode`, `--main-gpu` и `--tensor-split` интерпретируют список устройств по-разному. В `--split-mode tensor` явный список превращается в Meta device для tensor parallelism.

## INI-пресеты и router-режим

В INI:

```ini
device = CUDA0,CUDA1
```

В router-режиме model instances наследуют CLI/env роутера, но preset конкретной модели может задать свой `device`. Аргумент не относится к тем router-controlled параметрам, которые README перечисляет как удаляемые или перезаписываемые при загрузке модели.

## Типовые проблемы и диагностика

- `invalid device`: имя не совпадает с `--list-devices` или выбран CPU backend.
- Offload не происходит: проверьте, что `--gpu-layers` не равен `0` и не задано `--device none`.
- В multi-GPU занята не та карта: проверьте порядок имен в `--device` и значение `--main-gpu`.
- В логах загрузки ищите `using device ... - N MiB free` и строки распределения слоев.

## Примеры

```bash
llama-server --model /models/model.gguf --device CUDA0 --gpu-layers auto
```

```bash
llama-server --model /models/model.gguf --device CUDA1,CUDA2 --split-mode layer --gpu-layers all
```

```bash
llama-server --model /models/model.gguf --device none --gpu-layers 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama.cpp`
- `llama.cpp/tools/server/README.md`
