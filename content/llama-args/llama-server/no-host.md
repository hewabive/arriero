---
schema: 1
primaryName: "--no-host"
title: "--no-host"
summary: "Запрещает добавлять host buffer type от GPU-устройств в CPU fallback list. Это низкоуровневый флаг загрузки весов, полезный только для тонкой настройки buffer types."
category: "Общие параметры"
valueType: "boolean"
valueHint: null
aliases:
  - "--no-host"
allowedValues: []
env:
  - "LLAMA_ARG_NO_HOST"
related:
  - "--device"
  - "--gpu-layers"
  - "--override-tensor"
  - "--repack"
---

# --no-host

## Кратко

`--no-host` включает `params.no_host = true` и меняет список CPU buffer types, который используется при выборе размещения тензоров модели. Это не сетевой `--host` и не ограничение HTTP-доступа.

## Оригинальная справка llama.cpp

```text
bypass host buffer allowing extra buffers to be used
```

## Паспорт аргумента

- Основное имя: `--no-host`
- Тип: флаг
- Переменная окружения: `LLAMA_ARG_NO_HOST`
- Поле `common_params`: `no_host`
- Поле `llama_model_params`: `no_host`
- Значение по умолчанию: `false`
- Этап применения: построение buffer type list при загрузке модели

## Что меняет в llama-server

В `make_cpu_buft_list()` llama.cpp обычно добавляет host buffer type для каждого выбранного устройства, если backend его предоставляет. `--no-host` пропускает этот блок и позволяет дальше в списке использовать extra buffer types и CPU buffer без host buffer.

Флаг влияет на размещение весов и fallback buffer types, но не выбирает GPU сам по себе.

## Значения и формат

CLI-флаг без значения. Для env достаточно присутствия `LLAMA_ARG_NO_HOST` с truthy-значением при обработке void-флага.

## Когда использовать

Используйте только при осознанной настройке backend buffer types: например, если host buffer type конкретного устройства мешает использованию extra buffer type или вызывает проблемы загрузки.

В обычных конфигурациях лучше не задавать: дефолт оставляет llama.cpp больше вариантов для поддерживаемого размещения весов.

## Влияние на производительность и память

Эффект backend-specific. Отключение host buffer может уменьшить использование pinned/host-visible памяти устройства, но также может убрать быстрый путь для некоторых тензоров и привести к другому fallback.

На CUDA b10276 со stories15M и CPU-весами host model/compute изменились с 17/6 MiB до 14/9 MiB, хотя сумма почти сохранилась. Так как выбор buffer type и repack size backend-specific, Arriero возвращает для `--no-host` `low` confidence.

## Взаимодействие с другими аргументами

`--repack` управляет extra buffer types для weight repacking. `--no-host` может изменить порядок выбора buffer types рядом с этим механизмом.

`--override-tensor` может принудительно отправлять отдельные тензоры в конкретный buffer type; `--no-host` меняет доступные fallback-варианты для остальных тензоров.

## INI-пресеты и router-режим

В INI:

```ini
no-host = true
```

В router-режиме это модельный параметр. Не задавайте глобально, если разные модели или backends требуют разных buffer choices.

## Типовые проблемы и диагностика

- Ошибка `no suitable buffer type found`: уберите `--no-host` и проверьте, не нужен ли host buffer для части весов.
- Изменился объем RAM/VRAM: сравните строки `model buffer size` с флагом и без него.
- Путаница с сетью: для HTTP bind используется `--host`; `--no-host` к нему не относится.

## Примеры

```bash
llama-server --model /models/model.gguf --no-host
```

```bash
llama-server --model /models/model.gguf --no-host --repack
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/tools/server/README.md`
