---
schema: 1
primaryName: "--spec-draft-ngl"
title: "--spec-draft-ngl"
summary: "Управляет числом слоев draft-модели, размещаемых в VRAM. Поддерживает точное число, `auto` и `all`; применяется отдельно от `--gpu-layers` основной модели."
category: "Параметры speculative decoding"
valueType: "string"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-draft-ngl"
  - "-ngld"
  - "--gpu-layers-draft"
  - "--n-gpu-layers-draft"
allowedValues: []
env:
  - "LLAMA_ARG_N_GPU_LAYERS_DRAFT"
related:
  - "--gpu-layers"
  - "--spec-draft-device"
  - "--spec-draft-model"
  - "--spec-draft-hf"
  - "--spec-draft-override-tensor"
  - "--fit"
---

# --spec-draft-ngl

## Кратко

`--spec-draft-ngl` задает `common_params.speculative.draft.n_gpu_layers`: сколько слоев draft-модели llama.cpp пытается хранить и выполнять в VRAM. Это отдельный параметр от `--gpu-layers` для target-модели.

По умолчанию значение `auto`, в структуре это `-1`. `all` записывается как `-2`. Числовое значение парсится через `std::stoi()`.

## Оригинальная справка llama.cpp

```text
max. number of draft model layers to store in VRAM, either an exact number, 'auto', or 'all' (default: auto)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-ngl`
- Алиасы: `--spec-draft-ngl`, `-ngld`, `--gpu-layers-draft`, `--n-gpu-layers-draft`
- Значение: `auto`, `all` или целое число
- Структура llama.cpp: `common_params.speculative.draft.n_gpu_layers`
- Переменная окружения: `LLAMA_ARG_N_GPU_LAYERS_DRAFT`
- Значение по умолчанию: `auto`
- Этап применения: до загрузки draft-модели или MTP-контекста

## Что меняет в llama-server

При загрузке draft-модели сервер копирует значение в `params_dft.n_gpu_layers`, после чего `common_model_params_to_llama()` передает его загрузчику модели. При MTP без отдельной draft-модели этот параметр не размещает новые веса, но fit-логика все равно учитывает память MTP-контекста.

Если llama.cpp собран без пригодного GPU backend, обработчик печатает предупреждения, что `--gpu-layers-draft` будет проигнорирован.

## Значения и формат

- `auto` - использовать поведение по умолчанию/fit-подбор для draft-модели.
- `all` - попытаться выгрузить все возможные слои draft-модели на GPU.
- `0` - оставить слои draft-модели на CPU, если backend не переопределит поведение.
- Положительное число - максимум слоев draft-модели в VRAM.

Отрицательные числа кроме внутренних `-1`/`-2` через CLI не описаны help и не должны использоваться в UI.

## Когда использовать

Увеличивайте значение, когда draft-модель упирается в CPU и становится bottleneck. Снижайте значение, если target-модель и draft-модель вместе не помещаются в VRAM или fit начинает выгружать target сильнее, чем ожидалось.

Для маленькой draft-модели часто разумно `all`, если это не вытесняет слои target-модели.

## Влияние на производительность и память

Больше слоев draft-модели в VRAM обычно снижает latency draft-предсказания, но увеличивает VRAM и может ухудшить размещение основной модели. При `--fit` server-context оценивает память draft-модели/MTP и добавляет ее к fit target перед загрузкой target.

Проверяйте логи загрузки и сообщения `[spec] estimated memory usage of draft model ...`, а также итоговую acceptance. Быстрая draft-модель без acceptance не дает полезного ускорения.

## Взаимодействие с другими аргументами

`--spec-draft-device` ограничивает список устройств, на которые можно offload draft-модель. `--spec-draft-override-tensor`, `--spec-draft-cpu-moe` и `--spec-draft-n-cpu-moe` могут переопределить размещение отдельных tensor поверх общего числа слоев.

`--gpu-layers` управляет target-моделью и не заменяет `--spec-draft-ngl`.

## INI-пресеты и router-режим

В INI используйте `spec-draft-ngl = auto`, `gpu-layers-draft = all` или `n-gpu-layers-draft = 20`. Для model-specific preset это удобно держать рядом с `model-draft`.

## Типовые проблемы и диагностика

- Предупреждение `no usable GPU found`: бинарник без GPU backend или устройство недоступно.
- OOM при старте: уменьшите `--spec-draft-ngl`, `--gpu-layers` target-модели или KV-cache draft.
- Draft-модель загружается на CPU несмотря на значение: проверьте `--spec-draft-device`, доступные устройства через `--list-devices` и фактические backend-логи.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-ngl all
```

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-ngl 12
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
