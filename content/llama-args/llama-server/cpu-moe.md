---
schema: 1
primaryName: "--cpu-moe"
title: "--cpu-moe"
summary: "Оставляет все веса Mixture of Experts на CPU через tensor buffer override для MoE expert tensors. Полезно для экономии VRAM на MoE-моделях, но обычно увеличивает latency."
category: "Общие параметры"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "-cmoe"
  - "--cpu-moe"
allowedValues: []
env:
  - "LLAMA_ARG_CPU_MOE"
related:
  - "--n-cpu-moe"
  - "--gpu-layers"
  - "--override-tensor"
  - "--fit"
  - "--device"
---

# --cpu-moe

## Кратко

`--cpu-moe` принудительно размещает MoE expert weights на CPU. Это флаг без значения: само присутствие аргумента добавляет tensor buffer override для tensor names, соответствующих MoE experts.

Параметр имеет смысл только для MoE-архитектур. На dense-моделях он обычно не дает эффекта, потому что нет tensors, попадающих под MoE regex.

## Оригинальная справка llama.cpp

```text
keep all Mixture of Experts (MoE) weights in the CPU
```

## Паспорт аргумента

- Основное имя: `--cpu-moe`
- Алиасы: `-cmoe`, `--cpu-moe`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Переменная окружения: `LLAMA_ARG_CPU_MOE`
- Поле в `common_params`: `tensor_buft_overrides`
- Этап применения: парсинг CLI/env, загрузка модели

## Что меняет в llama-server

В `common/arg.cpp` обработчик добавляет `llm_ffn_exps_cpu_override()` в `params.tensor_buft_overrides`. В `common/common.h` этот override использует regex:

```text
\.ffn_(up|down|gate|gate_up)_(ch|)exps
```

и buffer type `ggml_backend_cpu_buffer_type()`. При загрузке модели `common/common.cpp` передает массив в `llama_model_params::tensor_buft_overrides`, а loader применяет pattern к tensor names.

## Значения и формат

У флага нет значения. В INI/preset boolean-like false обычно пропускает флаг, true включает его.

## Когда использовать

- MoE-модель не помещается в VRAM при нужном `--gpu-layers`.
- Нужно оставить dense layers на GPU, но выгрузить experts в RAM.
- Вы готовы обменять throughput/latency на меньший VRAM footprint.

## Влияние на производительность и память

VRAM может заметно снизиться на MoE-моделях, потому что expert tensors обычно занимают большую долю весов. RAM увеличится соответственно. Скорость часто падает: активные experts читаются и считаются через CPU/host path, а обмен данными между CPU и GPU может стать bottleneck.

Если включен auto fit (`--fit` по умолчанию в этой версии common params), пользовательские `tensor_buft_overrides` могут конфликтовать с подбором размещения: в `common/fit.cpp` есть ошибка `model_params::tensor_buft_overrides already set by user, abort`. Для диагностики повторите запуск с `--fit off`, если fit падает до загрузки модели.

## Взаимодействие с другими аргументами

- `--n-cpu-moe` делает то же частично: только первые `N` layers.
- `--override-tensor` также добавляет tensor buffer overrides; не смешивайте без необходимости.
- `--gpu-layers` определяет общий offload layers, а `--cpu-moe` точечно возвращает expert tensors на CPU.
- Для draft-модели speculative decoding есть отдельный `--spec-draft-cpu-moe`.

## INI-пресеты и router-режим

```ini
[moe-model]
gpu-layers = all
cpu-moe = true
```

В router mode задавайте `cpu-moe` в preset конкретной MoE-модели. Глобальный флаг router-а унаследуют все дочерние модели, включая dense-модели, где он просто не будет полезен.

## Типовые проблемы и диагностика

- VRAM не уменьшилась: проверьте, что модель действительно MoE и tensor names соответствуют regex `ffn_*_exps`.
- Старт падает на fit: проверьте сообщение `tensor_buft_overrides already set by user` и временно отключите `--fit`.
- Генерация стала медленной: это ожидаемый tradeoff; попробуйте `--n-cpu-moe N` вместо полного `--cpu-moe`.

## Примеры

```bash
llama-server --model /models/moe.gguf --gpu-layers all --cpu-moe
```

```bash
LLAMA_ARG_CPU_MOE=1 llama-server --model /models/moe.gguf --gpu-layers 99
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/tools/server/README.md`
