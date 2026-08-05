---
schema: 1
primaryName: "--fit-target"
title: "--fit-target"
summary: "Задает запас свободной памяти в MiB, который `--fit` должен оставить на каждом устройстве. Одно значение распространяется на все устройства, список задает разные запасы."
category: "Общие параметры"
valueType: "list"
estimation: "normal"
valueHint: "MiB0,MiB1,MiB2,..."
aliases:
  - "-fitt"
  - "--fit-target"
allowedValues: []
env:
  - "LLAMA_ARG_FIT_TARGET"
related:
  - "--fit"
  - "--fit-ctx"
  - "--gpu-layers"
  - "--tensor-split"
---

# --fit-target

## Кратко

`--fit-target` задает целевой запас свободной памяти для fit-to-memory. Единица измерения - MiB, без суффикса. Значение по умолчанию - `1024`, то есть 1 GiB запаса на устройство.

## Оригинальная справка llama.cpp

```text
target margin per device for --fit, comma-separated list of values, single value is broadcast across all devices, default: 1024
```

## Паспорт аргумента

- Основное имя: `--fit-target`
- Алиасы: `-fitt`, `--fit-target`
- Переменная окружения: `LLAMA_ARG_FIT_TARGET`
- Поле `common_params`: `fit_params_target`
- Внутренние единицы: bytes, после умножения MiB на `1024*1024`
- Значение по умолчанию: `1024`
- Этап применения: только при `--fit on`

## Что меняет в llama-server

Парсер делит строку по запятой или `/`, читает элементы через `std::stoull` и умножает на MiB. Если указан один элемент, он копируется во весь массив `fit_params_target`. Если элементов несколько, они записываются по индексам устройств.

Перед загрузкой multimodal/draft конфигураций `server-context.cpp` может увеличить эти targets, резервируя память под mmproj, draft model или MTP context.

## Значения и формат

- `1024`: оставить примерно 1 GiB свободной памяти на каждом устройстве.
- `2048,1024`: оставить разные запасы для первого и второго устройства.
- `0`: разрешить fit использовать почти весь обнаруженный free memory; рискованно для рабочих серверов.
- Суффиксы `MiB`, `GB` и дробные числа не поддерживаются.

## Когда использовать

Увеличивайте запас, если после успешного старта сервер падает на первом запросе, при росте batch или при параллельной нагрузке. Уменьшайте только на выделенной машине, где вы контролируете соседние процессы и готовы принять риск OOM.

## Влияние на производительность и память

Больший `--fit-target` обычно означает меньше offloaded слоев или меньший context, зато больше шанс стабильной работы. Слишком маленький target может дать быстрый старт, но падения при реальном трафике.

## Взаимодействие с другими аргументами

Работает только если `--fit on`. Не меняет явно заданные `--gpu-layers` и `--tensor-split`, если fit считает их пользовательскими.

С `--device` порядок значений соответствует порядку устройств. Если `--device` не задан, порядок берется из автоматического списка llama.cpp.

## INI-пресеты и router-режим

В INI:

```ini
fit-target = 2048
```

Для нескольких устройств:

```ini
device = CUDA0,CUDA1
fit-target = 2048,1024
```

В router-режиме лучше задавать per-model, если модели имеют разный размер или разные speculative/mmproj настройки.

## Типовые проблемы и диагностика

- Fit слишком консервативен: уменьшите target и проверьте логи распределения.
- OOM после старта: увеличьте target, особенно при `--parallel > 1`, vision/mmproj или draft model.
- Значения перепутались между GPU: задайте явный `--device`, чтобы порядок был стабильным.

## Примеры

```bash
llama-server --model /models/model.gguf --fit on --fit-target 2048
```

```bash
llama-server --model /models/model.gguf --device CUDA0,CUDA1 --fit on --fit-target 3072,1024
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
