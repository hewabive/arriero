---
schema: 1
primaryName: "--main-gpu"
title: "--main-gpu"
summary: "Выбирает основной GPU по индексу в списке устройств. В `split-mode=none` оставляет для модели только этот GPU, а в `split-mode=row` используется для промежуточных результатов и KV."
category: "Общие параметры"
valueType: "number"
valueHint: "INDEX"
aliases:
  - "-mg"
  - "--main-gpu"
allowedValues: []
env:
  - "LLAMA_ARG_MAIN_GPU"
related:
  - "--device"
  - "--gpu-layers"
  - "--split-mode"
  - "--tensor-split"
---

# --main-gpu

## Кратко

`--main-gpu` задает индекс основного устройства в списке, который llama.cpp сформировал автоматически или получил через `--device`. По умолчанию используется `0`.

Индекс относится к внутреннему списку llama.cpp, а не обязательно к системному PCI/NVIDIA index.

## Оригинальная справка llama.cpp

```text
the GPU to use for the model (with split-mode = none), or for intermediate results and KV (with split-mode = row) (default: 0)
```

## Паспорт аргумента

- Основное имя: `--main-gpu`
- Алиасы: `-mg`, `--main-gpu`
- Переменная окружения: `LLAMA_ARG_MAIN_GPU`
- Поле `common_params`: `main_gpu`
- Поле `llama_model_params`: `main_gpu`
- Значение по умолчанию: `0`
- Этап применения: загрузка модели, после построения списка устройств

## Что меняет в llama-server

Парсер записывает целое число в `common_params::main_gpu`. При `--split-mode none` функция подготовки устройств оставляет в модели только устройство с этим индексом.

Если `main_gpu < 0` в `split-mode none`, llama.cpp очищает список устройств. Это внутренне поддерживается кодом, но help не документирует отрицательные значения как пользовательский сценарий; для CPU-запуска понятнее использовать `--device none`.

Если индекс больше или равен числу доступных устройств, загрузка модели завершается ошибкой `invalid value for main_gpu`.

## Значения и формат

Значение - целое число. Нумерация начинается с `0` по порядку устройств llama.cpp. При явном `--device CUDA1,CUDA0` индекс `0` указывает на `CUDA1`.

## Когда использовать

Используйте с `--split-mode none`, когда на машине несколько GPU, но конкретная модель должна занять только одну карту.

В `--split-mode row` параметр влияет на устройство для промежуточных результатов и KV, поэтому его стоит проверять при балансировке VRAM и latency.

## Влияние на производительность и память

В `split-mode none` выбор `main_gpu` определяет всю VRAM, доступную для offload. Если выбрать карту с меньшим свободным объемом, `--fit auto` может перенести меньше слоев или не подобрать конфигурацию.

В `row` неверный основной GPU может создать лишние межустройственные копирования и ухудшить latency.

В оценщике Arriero `--main-gpu` применяется точно для `split-mode none`:
отрицательное значение дает host-only placement, а индекс за пределами
выбранного списка отклоняется. Для `row` итог остается `low`: веса делятся
между устройствами, а KV/intermediate buffers выбирают main GPU по
backend-specific схеме.

## Взаимодействие с другими аргументами

`--device` задает порядок и набор устройств, к которым применяется индекс.

`--split-mode none` делает `--main-gpu` критичным: остальные устройства будут удалены из списка модели.

`--tensor-split` имеет смысл для multi-GPU split-режимов; при `split-mode none` он фактически не балансирует слои между несколькими GPU.

## INI-пресеты и router-режим

В INI:

```ini
main-gpu = 1
```

В router-режиме значение может быть задано глобально или в preset конкретной модели. Учитывайте, что несколько одновременно загруженных моделей с одинаковым `main-gpu` будут конкурировать за одну карту.

## Типовые проблемы и диагностика

- `invalid value for main_gpu`: индекс не существует после применения `--device` и автоматической фильтрации устройств.
- Модель загрузилась не на ту карту: проверьте строки `using device ...` и порядок в `--device`.
- `--main-gpu` не означает "использовать только эту карту" вне `--split-mode none`.

## Примеры

```bash
llama-server --model /models/model.gguf --split-mode none --main-gpu 1 --gpu-layers auto
```

```bash
llama-server --model /models/model.gguf --device CUDA2,CUDA3 --split-mode none --main-gpu 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/src/llama.cpp`
- `llama.cpp/include/llama.h`
- `llama.cpp/tools/server/README.md`
