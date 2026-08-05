---
schema: 1
primaryName: "--split-mode"
title: "--split-mode"
summary: "Выбирает стратегию распределения модели между несколькими GPU: один GPU, послойное распределение, row split или экспериментальный tensor parallelism."
category: "Общие параметры"
valueType: "enum"
valueHint: "{none,layer,row,tensor}"
aliases:
  - "-sm"
  - "--split-mode"
allowedValues:
  - "none"
  - "layer"
  - "row"
  - "tensor"
env:
  - "LLAMA_ARG_SPLIT_MODE"
related:
  - "--device"
  - "--flash-attn"
  - "--fit"
  - "--gpu-layers"
  - "--main-gpu"
  - "--tensor-split"
---

# --split-mode

## Кратко

`--split-mode` определяет, как llama.cpp распределяет модель между несколькими устройствами. По умолчанию используется `layer`: слои и KV распределяются между GPU, а scheduler может включить pipeline parallelism при полной выгрузке.

## Оригинальная справка llama.cpp

```text
how to split the model across multiple GPUs, one of:
- none: use one GPU only
- layer (default): split layers and KV across GPUs (pipelined)
- row: split weight across GPUs by rows (parallelized)
- tensor: split weights and KV across GPUs (parallelized, EXPERIMENTAL)
```

## Паспорт аргумента

- Основное имя: `--split-mode`
- Алиасы: `-sm`, `--split-mode`
- Переменная окружения: `LLAMA_ARG_SPLIT_MODE`
- Поле `common_params`: `split_mode`
- Поле `llama_model_params`: `split_mode`
- Значение по умолчанию: `layer`
- Допустимые значения: `none`, `layer`, `row`, `tensor`

## Что меняет в llama-server

На парсинге строка превращается в `LLAMA_SPLIT_MODE_NONE`, `LLAMA_SPLIT_MODE_LAYER`, `LLAMA_SPLIT_MODE_ROW` или `LLAMA_SPLIT_MODE_TENSOR`. Неизвестное значение дает `invalid value`.

При `none` llama.cpp после выбора устройств оставляет только `--main-gpu`. При `tensor` создается Meta device из выбранных устройств; режим требует хотя бы одно не-CPU устройство.

## Значения и формат

- `none`: использовать один GPU, выбранный `--main-gpu`.
- `layer`: распределять слои и KV между GPU; дефолт и самый обычный multi-GPU режим.
- `row`: делить веса по строкам, если backend поддерживает split buffer type; `--main-gpu` используется для промежуточных результатов и KV.
- `tensor`: экспериментальный tensor parallelism; llama.cpp принудительно требует Flash Attention.

## Когда использовать

`layer` подходит для большинства multi-GPU запусков, особенно когда модель не помещается на одну карту. `none` нужен для изоляции модели на конкретной карте. `row` и `tensor` стоит применять только после контрольных замеров, потому что выигрыш зависит от backend, interconnect и размера batch.

## Влияние на производительность и память

`layer` может включить pipeline parallelism, когда модель полностью offloaded, устройств больше одного, KV offload включен и нет tensor overrides. Это повышает throughput, но scheduler резервирует больше compute memory.

`tensor` требует `--flash-attn on` или `auto`, не поддерживает quantized KV cache вместе с tensor split и может завершить создание context ошибкой при несовместимой конфигурации.

`--fit` не реализован для `SPLIT_MODE_TENSOR` и не умеет менять weight allocation для `ROW`; при таких комбинациях он логирует отказ и оставляет параметры как есть.

## Взаимодействие с другими аргументами

`--device` задает список устройств для split. Без него llama.cpp выбирает устройства автоматически.

`--gpu-layers` задает, сколько слоев вообще участвует в GPU offload.

`--tensor-split` задает пропорции по устройствам. В отсутствие `--tensor-split` используются пропорции свободной памяти.

`--flash-attn` обязателен для `tensor`; в `auto` llama.cpp включает его сам.

Arriero точно учитывает `none`: все offloaded layers, KV и основной compute идут
на выбранный `--main-gpu`, а остальные GPU не получают фиктивную долю. Для
multi-GPU `layer` явный `--tensor-split` стабилизирует веса и KV, но scheduler
scratch/pipeline-parallel compute распределяются backend-зависимо, поэтому
per-pool результат остается `low`; без split добавляется еще и зависимость от
свободной VRAM. `row` и `tensor` также дают `low`, потому что их
per-tensor/per-row placement нельзя представить послойным расчетом.

## INI-пресеты и router-режим

В INI:

```ini
split-mode = layer
```

Для router-режима это обычный модельный параметр. Если разные модели используют разные стратегии split, задавайте его в секциях конкретных моделей, а не глобально.

## Типовые проблемы и диагностика

- `SPLIT_MODE_TENSOR requires flash_attn to be enabled`: включите `--flash-attn on` или оставьте `auto`.
- `LLAMA_SPLIT_MODE_TENSOR needs >= 1 devices`: проверьте `--device` и сборку GPU backend.
- `--fit` не изменил offload: проверьте предупреждения `llama_params_fit is not implemented for SPLIT_MODE_TENSOR` или `LLAMA_SPLIT_MODE_ROW not implemented`.
- Неожиданная производительность: сравните `layer` и `none` на одинаковом `--gpu-layers`, затем отдельно тестируйте `row`/`tensor`.

## Примеры

```bash
llama-server --model /models/model.gguf --device CUDA0,CUDA1 --split-mode layer --gpu-layers auto
```

```bash
llama-server --model /models/model.gguf --split-mode none --main-gpu 0 --gpu-layers all
```

```bash
llama-server --model /models/model.gguf --device CUDA0,CUDA1 --split-mode tensor --flash-attn auto
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/src/llama.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
