---
schema: 1
primaryName: "--image-min-tokens"
title: "--image-min-tokens"
summary: "Задает нижнюю границу числа токенов на изображение для vision-моделей с dynamic resolution. По умолчанию значение читается из projector/model metadata."
category: "Параметры llama-server"
valueType: "number"
valueHint: "N"
aliases:
  - "--image-min-tokens"
allowedValues: []
env:
  - "LLAMA_ARG_IMAGE_MIN_TOKENS"
related:
  - "--image-max-tokens"
  - "--mmproj"
  - "--mmproj-offload"
  - "--ctx-size"
---

# --image-min-tokens

## Кратко

`--image-min-tokens` задает минимальное число токенов, которое может занять каждое изображение в vision-моделях с dynamic resolution. Значение записывается в `common_params.image_min_tokens` и передается в `mtmd_context_params.image_min_tokens` при загрузке `mmproj`.

По умолчанию в `common_params` стоит `-1`, что соответствует справке `read from model`.

## Оригинальная справка llama.cpp

```text
minimum number of tokens each image can take, only used by vision models with dynamic resolution (default: read from model)
```

## Паспорт аргумента

- Основное имя: `--image-min-tokens`
- Алиасы: `--image-min-tokens`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `number`
- Подсказка формата из `--help`: `N`
- Переменные окружения: `LLAMA_ARG_IMAGE_MIN_TOKENS`
- Значение по умолчанию: read from model (`-1` во внутренней структуре)
- Внутреннее поле: `common_params.image_min_tokens`

## Что меняет в llama-server

Флаг влияет только при наличии `mmproj`. В `server_context::load_model()` значение копируется в mtmd params до вызова `mtmd_init_from_file()`. Для моделей без dynamic resolution или без projector аргумент практически не используется.

## Значения и формат

Парсер принимает integer через общий CLI handler без дополнительной проверки диапазона в `arg.cpp`. Практически используйте положительные значения. Значение меньше или равное нулю стоит оставлять только если вы сознательно полагаетесь на поведение mtmd/model defaults.

`--image-min-tokens` должен быть не больше `--image-max-tokens`, если оба заданы; явной проверки в CLI-обработчике этого аргумента не видно, поэтому ошибочная комбинация может проявиться позже в mtmd.

## Когда использовать

Используйте этот аргумент, когда нужно ограничить dynamic resolution снизу: например, чтобы маленькие изображения не деградировали до слишком малого числа visual tokens. Если вы не диагностируете качество/память vision модели, оставьте default из модели.

## Влияние на производительность и память

Чем выше минимум, тем больше visual tokens может попасть в prompt даже для простых изображений. Это увеличивает использование context window, latency preprocessing/prompt evaluation и KV-cache pressure.

## Взаимодействие с другими аргументами

- `--image-max-tokens`: верхняя граница; проверяйте пару вместе.
- `--mmproj`: без projector параметр не применяется.
- `--ctx-size`: visual tokens занимают контекст наряду с текстом.
- `--parallel`: несколько слотов с изображениями умножают pressure на память.

## INI-пресеты и router-режим

```ini
[vision_dynamic_resolution]
hf-repo = ggml-org/gemma-3-4b-it-GGUF:Q8_0
image-min-tokens = 256
image-max-tokens = 1024
```

В router-пресетах задавайте эти границы per-model, потому что разные vision architectures могут иметь разные нормальные диапазоны.

## Типовые проблемы и диагностика

- Запросы с изображениями стали медленнее: уменьшите `--image-min-tokens`.
- Модель теряет детали на малых изображениях: поднимайте минимум небольшими шагами.
- Ошибки контекста/OOM: visual tokens могли вытеснить текстовый бюджет; проверьте `--ctx-size`, `--parallel` и max bound.

## Примеры

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --image-min-tokens 256
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
