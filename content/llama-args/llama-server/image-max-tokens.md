---
schema: 1
primaryName: "--image-max-tokens"
title: "--image-max-tokens"
summary: "Задает верхнюю границу числа токенов на изображение для vision-моделей с dynamic resolution. Используется только через multimodal projector."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--image-max-tokens"
allowedValues: []
env:
  - "LLAMA_ARG_IMAGE_MAX_TOKENS"
related:
  - "--image-min-tokens"
  - "--mmproj"
  - "--mmproj-offload"
  - "--ctx-size"
  - "--parallel"
---

# --image-max-tokens

## Кратко

`--image-max-tokens` задает максимальное число токенов, которое может занять каждое изображение в vision-моделях с dynamic resolution. Значение записывается в `common_params.image_max_tokens` и передается в `mtmd_context_params.image_max_tokens`.

Default во внутренней структуре - `-1`, то есть верхняя граница читается из модели/projector.

## Оригинальная справка llama.cpp

```text
maximum number of tokens each image can take, only used by vision models with dynamic resolution (default: read from model)
```

## Паспорт аргумента

- Основное имя: `--image-max-tokens`
- Алиасы: `--image-max-tokens`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `number`
- Подсказка формата из `--help`: `N`
- Переменные окружения: `LLAMA_ARG_IMAGE_MAX_TOKENS`
- Значение по умолчанию: read from model (`-1` во внутренней структуре)
- Внутреннее поле: `common_params.image_max_tokens`

## Что меняет в llama-server

Параметр копируется в mtmd params только при loaded `mmproj`. Он ограничивает dynamic resolution сверху: сколько visual tokens одно изображение может занять до передачи в основной контекст.

## Значения и формат

Парсер принимает integer без явной проверки диапазона в `arg.cpp`. Практически используйте положительные значения. Слишком низкий максимум может ухудшить понимание деталей изображения; слишком высокий - резко увеличить prompt tokens и память.

Если задан и `--image-min-tokens`, максимум должен быть не меньше минимума.

## Когда использовать

Используйте `--image-max-tokens`, чтобы ограничить стоимость vision запросов на публичном или многопользовательском сервере. Это особенно важно, когда пользователи могут отправлять крупные изображения и занимать большую часть context window.

## Влияние на производительность и память

Увеличение максимума может улучшить detail retention, но повышает:

- latency обработки изображения;
- число prompt tokens;
- KV-cache usage;
- риск отказов при большом `--parallel`.

Снижение максимума ограничивает worst-case, но может ухудшить ответы по мелким деталям.

## Взаимодействие с другими аргументами

- `--image-min-tokens`: нижняя граница; задавайте согласованную пару.
- `--mmproj`: без projector параметр не используется.
- `--ctx-size`: visual tokens расходуют общий контекст.
- `--parallel`: несколько одновременных multimodal запросов усиливают memory pressure.

## INI-пресеты и router-режим

```ini
[vision_limited]
hf-repo = ggml-org/gemma-3-4b-it-GGUF:Q8_0
image-max-tokens = 768
```

В router-пресетах это хороший per-model лимит для защиты VRAM/RAM и latency.

## Типовые проблемы и диагностика

- OOM или резкий рост latency на изображениях: снижайте `--image-max-tokens`.
- Модель плохо читает мелкий текст на изображении: максимум может быть слишком низким.
- Ошибка только на multimodal запросах: проверьте loaded `mmproj`, bounds и размер контекста.

## Примеры

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --image-max-tokens 768
```

```bash
llama-server --model /srv/models/vision.gguf --mmproj /srv/models/mmproj-F16.gguf --image-min-tokens 256 --image-max-tokens 1024
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
