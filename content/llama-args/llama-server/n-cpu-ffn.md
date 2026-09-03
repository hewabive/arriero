---
schema: 1
primaryName: "--n-cpu-ffn"
title: "--n-cpu-ffn"
summary: "Оставляет dense FFN weights первых `N` блоков на CPU, чтобы частично разгрузить VRAM у dense-модели. Для MoE expert weights нужен отдельный `--n-cpu-moe`."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-ncffn"
  - "--n-cpu-ffn"
allowedValues: []
env:
  - "LLAMA_ARG_N_CPU_FFN"
related:
  - "--n-cpu-moe"
  - "--cpu-moe"
  - "--gpu-layers"
  - "--override-tensor"
  - "--fit"
---

# --n-cpu-ffn

## Кратко

`--n-cpu-ffn N` принудительно размещает dense FFN tensors первых `N` transformer blocks в CPU buffer. Это точечный способ освободить VRAM у dense-модели, когда переносить целые слои через `--gpu-layers` слишком грубо.

Флаг не предназначен для MoE expert weights: для них используются `--n-cpu-moe` или `--cpu-moe`.

## Оригинальная справка llama.cpp

```text
keep the dense FFN weights of the first N layers in the CPU
(dense models; for MoE expert weights use --n-cpu-moe)
```

## Паспорт аргумента

- Основное имя: `--n-cpu-ffn`
- Алиас: `-ncffn`
- Формат: целое число `N`, не меньше `0`
- Переменная окружения: `LLAMA_ARG_N_CPU_FFN`
- Поле: добавляет записи в `common_params::tensor_buft_overrides`
- Этап применения: разбор CLI/env, затем выбор buffer type при загрузке модели

## Что меняет в llama-server

Для каждого номера блока от `0` до `N - 1` обработчик добавляет CPU override для tensor names, совпадающих с шаблоном `blk.<i>.ffn_(up|down|gate).`. В результате dense FFN up/down/gate weights этих блоков остаются в RAM, даже если общий `--gpu-layers` отправляет блоки на GPU.

Остальные tensors блока и FFN следующих блоков продолжают подчиняться обычному размещению и другим tensor overrides.

## Значения и формат

- `0` не добавляет overrides и фактически выключает механизм.
- Положительное `N` охватывает первые `N` блоков, начиная с `blk.0`.
- Отрицательное значение завершает разбор с `invalid value`.

Значение больше фактического числа блоков не создаёт дополнительных tensors: лишние regex-шаблоны просто ни с чем не совпадут. Это обычно признак ошибочного пресета, а не полезная настройка.

## Когда использовать

Используйте флаг, когда dense-модель почти помещается в VRAM и нужна частичная разгрузка именно крупных FFN weights. Подбирайте `N` ступенчато по фактическому потреблению памяти и latency; оптимальное число зависит от размера FFN, backend-а и пропускной способности CPU↔GPU.

Для MoE-модели этот флаг не заменяет `--n-cpu-moe`: expert tensors имеют другой шаблон имён.

## Влияние на производительность и память

Рост `N` уменьшает объём FFN weights в VRAM и увеличивает занятость RAM. Вычисления с CPU-resident weights могут добавить CPU-работу и обмен данными с GPU, поэтому generation latency и особенно throughput под нагрузкой обычно ухудшаются.

Точная экономия на блок неодинакова между архитектурами и quantization formats. Сверяйте итоговое размещение и память по startup log, а скорость — на характерных prompt/generation workloads.

## Взаимодействие с другими аргументами

- `--gpu-layers` задаёт общее GPU-размещение, а `--n-cpu-ffn` переопределяет dense FFN tensors первых блоков обратно на CPU.
- `--n-cpu-moe` делает аналогичный частичный override для MoE experts; шаблоны у двух флагов различаются.
- `--cpu-moe` оставляет на CPU все MoE experts и не относится к dense FFN.
- `--override-tensor` позволяет задать собственные regex overrides; избегайте пересекающихся правил, если порядок и выбранный buffer type не очевидны.
- Ручные tensor overrides могут ограничивать работу `--fit`; если auto-fit отказывается продолжать из-за пользовательских overrides, проверьте запуск с `--fit off`.

## INI-пресеты и router-режим

```ini
[dense-model]
gpu-layers = all
n-cpu-ffn = 6
```

В router mode держите значение в model preset: число блоков и стоимость одного FFN зависят от конкретной модели.

## Типовые проблемы и диагностика

- `invalid value`: передано отрицательное `N` или нецелое значение.
- VRAM не уменьшилась: проверьте, что модель dense и её tensor names совпадают с поддерживаемым FFN-шаблоном.
- Производительность резко упала: уменьшите `N` либо перенесите больше работы обратно на GPU.
- Auto-fit прерван сообщением о пользовательских tensor buffer overrides: для диагностики отключите `--fit` и задайте размещение явно.

## Примеры

```bash
llama-server --model /models/dense.gguf --gpu-layers all --n-cpu-ffn 6
LLAMA_ARG_N_CPU_FFN=4 llama-server --model /models/dense.gguf --gpu-layers all
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/src/llama-model-loader.cpp`
- https://github.com/ggml-org/llama.cpp/pull/26622
