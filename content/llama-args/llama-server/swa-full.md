---
schema: 1
primaryName: "--swa-full"
title: "--swa-full"
summary: "Включает full-size SWA cache для моделей со Sliding Window Attention. Если модель не поддерживает SWA, сервер отключает флаг с предупреждением."
category: "Общие параметры"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--swa-full"
allowedValues: []
env:
  - "LLAMA_ARG_SWA_FULL"
related:
  - "--ctx-size"
  - "--fit"
  - "--kv-unified"
---

# --swa-full

## Кратко

`--swa-full` включает полноразмерный SWA cache вместо ограниченного Sliding Window Attention поведения. Это увеличивает память KV/cache для SWA-моделей, но может быть нужно для сценариев, где требуется полный attention window.

## Оригинальная справка llama.cpp

```text
use full-size SWA cache (default: false)
[(more info)](https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055)
```

## Паспорт аргумента

- Основное имя: `--swa-full`
- Тип: флаг
- Переменная окружения: `LLAMA_ARG_SWA_FULL`
- Поле `common_params`: `swa_full`
- Поле `llama_context_params`: `swa_full`
- Значение по умолчанию: `false`
- Этап применения: создание context и memory/KV cache

## Что меняет в llama-server

Парсер выставляет `params.swa_full = true`. При инициализации сервер проверяет модель: если модель не использует SWA, `server-context.cpp` сбрасывает флаг и пишет warning `swa_full is not supported by this model, it will be disabled`.

Для поддерживаемых моделей флаг передается в context params и далее в SWA memory/KV-cache реализацию.

## Значения и формат

CLI-флаг без значения. Для env используется `LLAMA_ARG_SWA_FULL` с truthy-значением.

## Когда использовать

Используйте только для моделей со SWA, когда стандартное sliding-window поведение ограничивает нужный сценарий. Для обычных моделей или коротких контекстов флаг не нужен.

## Влияние на производительность и память

Главный эффект - рост памяти под SWA cache. Чем больше `--ctx-size`, `--parallel` и KV precision, тем заметнее память. На GPU-offload конфигурациях это может съесть VRAM и изменить результат `--fit`.

## Взаимодействие с другими аргументами

`--ctx-size` и `--parallel` определяют масштаб KV/cache memory.

`--fit` учитывает context memory при оценке, поэтому `--swa-full` может привести к меньшему числу GPU layers или к отказу fit подобрать конфигурацию.

`--kv-unified` меняет организацию KV cache; проверяйте фактические логи memory allocation на вашей модели.

## INI-пресеты и router-режим

В INI:

```ini
swa-full = true
```

В router-режиме задавайте per-model: глобальное включение приведет к лишним предупреждениям на моделях без SWA и может увеличить память там, где это не нужно.

## Типовые проблемы и диагностика

- Warning `swa_full is not supported`: модель не поддерживает этот режим, флаг будет отключен.
- OOM после включения: уменьшите `--ctx-size`, `--parallel`, увеличьте `--fit-target` или отключите `--swa-full`.
- Нет видимого эффекта: проверьте, что модель действительно имеет SWA layers.

## Примеры

```bash
llama-server --model /models/swa-model.gguf --swa-full
```

```bash
llama-server --model /models/swa-model.gguf --swa-full --fit on --fit-target 2048
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
