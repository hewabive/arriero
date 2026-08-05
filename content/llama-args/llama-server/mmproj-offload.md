---
schema: 1
primaryName: "--mmproj-offload"
title: "--mmproj-offload"
summary: "Включает или отключает GPU offload для multimodal projector. По умолчанию включено; `--no-mmproj-offload` держит projector-вычисления на CPU."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--mmproj-offload"
  - "--no-mmproj-offload"
allowedValues: []
env:
  - "LLAMA_ARG_MMPROJ_OFFLOAD"
related:
  - "--mmproj"
  - "--mmproj-url"
  - "--mmproj-auto"
  - "--gpu-layers"
  - "--device"
---

# --mmproj-offload

## Кратко

`--mmproj-offload` управляет тем, будет ли multimodal projector использовать GPU backend. Значение записывается в `common_params.mmproj_use_gpu` и затем передается в `mtmd_context_params.use_gpu`.

По умолчанию включено. Отрицательная форма `--no-mmproj-offload` отключает GPU offload projector.

## Оригинальная справка llama.cpp

```text
whether to enable GPU offloading for multimodal projector (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--mmproj-offload`
- Положительная форма: `--mmproj-offload`
- Отрицательная форма: `--no-mmproj-offload`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `flag`
- Переменные окружения: `LLAMA_ARG_MMPROJ_OFFLOAD`
- Значение по умолчанию: enabled
- Внутреннее поле: `common_params.mmproj_use_gpu`

## Что меняет в llama-server

В `server_context::load_model()` при наличии `mmproj.path` server создает `mtmd_context_params` и выставляет:

```text
mparams.use_gpu = params_base.mmproj_use_gpu
```

Дальше эти параметры используются при `mtmd_init_from_file()`. Если projector не загружается, флаг не оказывает runtime-эффекта.

## Значения и формат

В CLI это флаг без отдельного значения:

- `--mmproj-offload` - включить GPU offload;
- `--no-mmproj-offload` - отключить GPU offload.

В INI/preset используйте boolean-значение или отрицательный ключ `no-mmproj-offload`, следуя правилам preset parser.

## Когда использовать

Оставляйте включенным, если VRAM хватает и multimodal latency важна. Отключайте при ошибках выделения VRAM, нестабильном GPU backend или когда основной LLM должен получить приоритет по памяти.

## Влияние на производительность и память

Включение offload обычно снижает latency multimodal preprocessing, но увеличивает VRAM usage. При `--fit` server оценивает worst-case memory usage `mmproj` и добавляет ее к fit targets, поэтому этот флаг влияет на планирование памяти.

Выключение переносит нагрузку на CPU; это может замедлить обработку изображений/аудио, но уменьшить давление на GPU.

## Взаимодействие с другими аргументами

- `--mmproj`/`--mmproj-url`/auto `mmproj`: флаг действует только при loaded projector.
- `--gpu-layers` и `--device`: управляют основной моделью/GPU устройствами; projector offload использует mtmd backend параметры отдельно.
- `--flash-attn`: значение `flash_attn_type` также передается в mtmd context params.

## INI-пресеты и router-режим

```ini
[vision_cpu_projector]
model = /srv/models/vision.gguf
mmproj = /srv/models/mmproj-F16.gguf
no-mmproj-offload = true
```

Для router с несколькими multimodal моделями настройка полезна как per-preset способ разгрузить VRAM.

## Типовые проблемы и диагностика

- OOM при старте vision модели: попробуйте `--no-mmproj-offload` и уменьшение `--gpu-layers`.
- Multimodal работает медленно: проверьте, не отключен ли offload.
- Флаг не меняет поведение: убедитесь, что projector действительно загружен, ищите `loaded multimodal model`.

## Примеры

```bash
llama-server --model /srv/models/vision.gguf --mmproj /srv/models/mmproj-F16.gguf --no-mmproj-offload
```

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --mmproj-offload
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
