---
schema: 1
primaryName: "--fit"
title: "--fit"
summary: "Включает автоматический подбор незаданных параметров под доступную память устройства. По умолчанию включен и может изменить `n_gpu_layers`, `tensor_split` и context size перед загрузкой модели."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: "[on|off]"
aliases:
  - "-fit"
  - "--fit"
allowedValues:
  - "on"
  - "off"
env:
  - "LLAMA_ARG_FIT"
related:
  - "--fit-ctx"
  - "--fit-target"
  - "--gpu-layers"
  - "--split-mode"
  - "--tensor-split"
---

# --fit

## Кратко

`--fit` включает механизм fit-to-memory. Перед реальной загрузкой модели llama.cpp делает пробную no-alloc загрузку, оценивает memory breakdown и пытается подобрать незаданные параметры так, чтобы оставить заданный запас памяти.

Дефолт текущего `llama-server` - `on`.

## Оригинальная справка llama.cpp

```text
whether to adjust unset arguments to fit in device memory ('on' or 'off', default: 'on')
```

## Паспорт аргумента

- Основное имя: `--fit`
- Алиасы: `-fit`, `--fit`
- Переменная окружения: `LLAMA_ARG_FIT`
- Поле `common_params`: `fit_params`
- Значение по умолчанию: `on`
- Этап применения: перед `llama_model_load_from_file()`

## Что меняет в llama-server

При `fit_params = true` `common_init_from_params()` вызывает `common_fit_params()` до реальной загрузки модели. Fit получает model params, context params, массив `tensor_split`, buffer overrides, `fit_params_target` и `fit_params_min_ctx`.

Механизм может уменьшить context size, если `--ctx-size` оставлен равным `0`, подобрать `n_gpu_layers`, заполнить `tensor_split` и добавить tensor buffer overrides для частичных слоев/MoE. Он не считается hard failure: при невозможности подобрать параметры логируется warning, а запуск продолжается с текущими параметрами, если дальнейшая загрузка модели пройдет.

## Значения и формат

Парсер принимает truthy-значения `on`, `enabled`, `true`, `1` и falsey-значения `off`, `disabled`, `false`, `0`.

## Когда использовать

Оставляйте `on` для рабочих серверов, где модели, контекст или свободная VRAM могут меняться. Ставьте `off`, если нужна полностью воспроизводимая конфигурация или вы отлаживаете баг, который появляется только во время fit-step.

## Влияние на производительность и память

Fit добавляет время старта: он загружает модель в режиме `no_alloc`, создает context и может повторять оценки для разных вариантов распределения. Во время работы сервера latency не меняется напрямую, но выбранные fit параметры влияют на VRAM, RAM и скорость.

Для multimodal и speculative configurations сервер дополнительно увеличивает `fit_params_target`, резервируя память под mmproj, draft model или MTP context.

Такой результат зависит от свободной RAM/VRAM в момент старта. Поэтому Arriero показывает консервативную проекцию model-default/full-offload, но снижает confidence до `low`, если при включенном fit не задан context или GPU layers оставлены `auto`. Для воспроизводимой проверки задайте `--ctx-size`, `--gpu-layers` и multi-GPU `--tensor-split` явно и используйте `--fit off`.

## Взаимодействие с другими аргументами

`--fit-target` задает запас памяти, который fit пытается оставить на каждом устройстве.

`--fit-ctx` задает минимальный context size, до которого fit может снижать `--ctx-size 0`. Если пользователь явно задал `--ctx-size`, context не уменьшается; если задал `--ctx-size 0`, код дополнительно запрещает reduction полного model context.

Fit не переписывает явно заданные `--gpu-layers`, `--tensor-split` и `--override-tensor`. Для `--split-mode tensor` fit не реализован; для `row` не реализовано изменение weight allocation.

## INI-пресеты и router-режим

В INI:

```ini
fit = on
fit-target = 1024
fit-ctx = 4096
```

В router-режиме model instances наследуют CLI/env роутера, а preset конкретной модели может изменить `fit`. Это полезно для моделей с разными VRAM-требованиями.

## Типовые проблемы и диагностика

- Долгий старт: fit делает дополнительные оценки памяти; сравните с `--fit off`.
- Параметры неожиданно изменились: ищите `fitting params to device memory ...`.
- Fit отказался менять конфигурацию: ищите warning `failed to fit params to free device memory`.
- Баг проявляется только с fit: llama.cpp сам рекомендует воспроизвести с `-fit off` или дать `--verbose` логи.

## Примеры

```bash
llama-server --model /models/model.gguf --fit on --gpu-layers auto
```

```bash
llama-server --model /models/model.gguf --fit off --gpu-layers 40
```

```bash
llama-server --model /models/model.gguf --fit on --fit-target 2048 --fit-ctx 8192
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
