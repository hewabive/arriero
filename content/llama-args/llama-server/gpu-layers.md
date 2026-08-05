---
schema: 1
primaryName: "--gpu-layers"
title: "--gpu-layers"
summary: "Задает, сколько слоев модели llama.cpp пытается разместить в VRAM. Поддерживает точное число, `auto` для подбора через fit-to-memory и `all` для полной выгрузки доступных слоев на GPU."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "N"
aliases:
  - "-ngl"
  - "--gpu-layers"
  - "--n-gpu-layers"
allowedValues: []
env:
  - "LLAMA_ARG_N_GPU_LAYERS"
related:
  - "--device"
  - "--fit"
  - "--fit-target"
  - "--main-gpu"
  - "--split-mode"
  - "--tensor-split"
---

# --gpu-layers

## Кратко

`--gpu-layers` управляет количеством слоев, которые будут храниться в VRAM и выполняться на выбранных устройствах. В текущем llama.cpp значение по умолчанию в `common_params` равно `-1`, то есть `auto`: до загрузки модели включенный по умолчанию `--fit on` может подобрать число слоев под свободную память устройства.

Аргумент применяется только на старте, до загрузки модели. После запуска сервера изменить распределение слоев без перезагрузки модели нельзя.

## Оригинальная справка llama.cpp

```text
max. number of layers to store in VRAM, either an exact number, 'auto', or 'all' (default: auto)
```

## Паспорт аргумента

- Основное имя: `--gpu-layers`
- Алиасы: `-ngl`, `--gpu-layers`, `--n-gpu-layers`
- Переменная окружения: `LLAMA_ARG_N_GPU_LAYERS`
- Поле `common_params`: `n_gpu_layers`
- Поле `llama_model_params`: `n_gpu_layers`
- Значение по умолчанию: `auto`
- Этап применения: парсинг CLI/env, затем подбор `--fit`, затем загрузка модели

## Что меняет в llama-server

Парсер записывает значение в `common_params::n_gpu_layers`: `auto` превращается в `-1`, `all` в `-2`, числовое значение парсится через `std::stoi`. В `common_model_params_to_llama()` это значение копируется в `llama_model_params::n_gpu_layers`.

В загрузчике модели отрицательное значение означает "все слои": `llama_model::n_gpu_layers()` возвращает `hparams.n_layer + 1`. Дополнительная единица нужна для выходного слоя: в логе можно увидеть отдельную строку `offloading output layer to GPU`, а затем число repeating layers.

Если llama.cpp собран без GPU-offload, аргумент не падает на парсинге, но печатает предупреждения, что `--gpu-layers` будет проигнорирован и, вероятно, бинарник собран без GPU-поддержки.

## Значения и формат

- `auto`: оставить выбор `--fit`; это дефолт текущего `llama-server`.
- `all`: запросить перенос всех доступных слоев, включая output layer, на GPU.
- `0`: не переносить repeating/output layers на GPU, но backend все равно может использоваться для отдельных операций, если это разрешено другими параметрами.
- Положительное число: точное число слоев, учитывая output layer в общей логике offload.
- Отрицательные числа кроме специальных внутренних значений не документированы как пользовательский формат; используйте `auto` или `all`.

## Когда использовать

Используйте `auto`, если сервер должен сам снижать нагрузку на VRAM при смене моделей, контекста или числа слотов. Используйте точное число, когда нужна воспроизводимость между рестартами и вы уже знаете, сколько слоев стабильно помещается.

`all` полезен для минимизации CPU-участия на GPU-сервере, но это самый рискованный вариант по VRAM. На публичном или многомодельном сервере лучше оставить запас через `--fit-target`, а не загружать VRAM до конца.

## Влияние на производительность и память

Чем больше слоев в VRAM, тем меньше CPU/RAM-трафика и обычно ниже latency. Цена - рост VRAM под веса модели. KV-cache и compute buffers зависят не только от `--gpu-layers`, но и от `--ctx-size`, `--parallel`, типов KV-cache и split-режима.

При `--fit on` параметр может быть изменен до загрузки модели, но только если пользователь не задал точное значение. Если `n_gpu_layers` уже отличается от дефолта, fit-to-memory не будет его переписывать и в случае нехватки памяти залогирует отказ вида `n_gpu_layers already set by user`.

## Взаимодействие с другими аргументами

`--device` ограничивает список устройств, между которыми распределяются слои. Без него llama.cpp выбирает доступные GPU/RPC-устройства автоматически.

`--split-mode` определяет стратегию multi-GPU. В `layer` слои и KV распределяются по устройствам, в `row` веса могут делиться построчно, в `tensor` используется экспериментальный tensor parallelism.

`--tensor-split` задает пропорции распределения. Если он не задан, загрузчик использует свободную память устройств как веса распределения.

`--fit`, `--fit-target` и `--fit-ctx` могут подобрать `n_gpu_layers`, `tensor_split` и иногда уменьшить контекст, но не переписывают явно заданное пользователем число слоев.

## INI-пресеты и router-режим

В INI-пресете пишите ключ без ведущих дефисов:

```ini
n-gpu-layers = auto
```

Короткий ключ `ngl` и переменная `LLAMA_ARG_N_GPU_LAYERS` также поддерживаются механизмом пресетов. В router-режиме модельные subprocess-настройки наследуют CLI/env роутера, а модельный preset может переопределить значение для конкретной модели.

## Типовые проблемы и диагностика

- `warning: no usable GPU found`: проверьте сборку llama.cpp, драйверы и вывод `--list-devices`.
- OOM при загрузке: уменьшите число слоев, включите `--fit on`, увеличьте `--fit-target` или снизьте `--ctx-size`.
- Значение неожиданно изменилось при старте: смотрите логи `common_init_from_params: fitting params to device memory ...`; это работа `--fit`.
- Непонятно, сколько реально ушло на GPU: ищите строки `offloading output layer to GPU`, `offloading N repeating layers to GPU`, `model buffer size`.

## Примеры

```bash
llama-server --model /models/qwen.gguf --gpu-layers auto
```

```bash
llama-server --model /models/qwen.gguf --gpu-layers 35 --fit off
```

```bash
llama-server --model /models/qwen.gguf --device CUDA0,CUDA1 --split-mode layer --gpu-layers all
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/tools/server/README.md`
