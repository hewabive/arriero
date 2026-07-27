---
schema: 1
primaryName: "--mtmd-batch-max-tokens"
title: "--mtmd-batch-max-tokens"
summary: "Максимум image-токенов в одном батче при энкодинге изображений multimodal projector'ом. Default 1024; ограничивает пиковую память энкодера."
category: "Параметры llama-server"
valueType: "number"
valueHint: "N"
aliases:
  - "--mtmd-batch-max-tokens"
allowedValues: []
env:
  - "LLAMA_ARG_MTMD_BATCH_MAX_TOKENS"
related:
  - "--mmproj"
  - "--image-max-tokens"
  - "--image-min-tokens"
  - "--batch-size"
---

# --mtmd-batch-max-tokens

## Кратко

`--mtmd-batch-max-tokens` задает, сколько image-токенов сервер обрабатывает за один проход при кодировании изображений через multimodal projector. Значение записывается в `common_params::mtmd_batch_max_tokens` и при инициализации mtmd-контекста копируется в `mtmd_context_params.batch_max_tokens` (`server-context.cpp`). По умолчанию `1024`.

## Оригинальная справка llama.cpp

```text
maximum number of image tokens per batch when encoding images (default: 1024)
```

## Паспорт аргумента

- Основное имя: `--mtmd-batch-max-tokens`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `number`
- Подсказка формата из `--help`: `N`
- Переменная окружения: `LLAMA_ARG_MTMD_BATCH_MAX_TOKENS`
- Поле в `common_params`: `mtmd_batch_max_tokens`
- Значение по умолчанию: `1024`

## Что меняет в llama-server

Параметр используется только при загруженном `mmproj`. Он управляет размером батча на стороне энкодера изображений: визуальные токены одного запроса нарезаются на группы не больше указанного значения и кодируются по группам. Это отличается от `--image-max-tokens`/`--image-min-tokens`, которые задают, сколько токенов изображение займет в итоге; `--mtmd-batch-max-tokens` влияет на гранулярность самого энкодинга, а не на финальную длину.

## Значения и формат

Парсер принимает положительный integer. Меньшее значение снижает пиковую память энкодера за счет большего числа проходов; большее — наоборот. Без `mmproj` параметр ни на что не влияет.

## Когда использовать

Понижайте значение, если энкодинг крупных изображений упирается в память на слабой GPU/CPU. Поднимайте, если хотите уменьшить число проходов энкодера на мощном железе. Для большинства сценариев default `1024` адекватен.

## Влияние на производительность и память

Прямо задает trade-off «пиковая память энкодера ↔ число проходов» при обработке изображений. На текстовый инференс и на KV-cache основной модели не влияет.

## Взаимодействие с другими аргументами

- `--mmproj`: без projector параметр не задействуется.
- `--image-max-tokens` / `--image-min-tokens`: задают итоговое число visual-токенов на изображение, тогда как этот флаг — размер батча энкодинга.
- `--batch-size`: батч основного текстового пайплайна, не связан с энкодингом изображений.

## Типовые проблемы и диагностика

- OOM именно на этапе обработки изображения: попробуйте понизить `--mtmd-batch-max-tokens`.
- Параметр «не действует»: проверьте, что загружен `mmproj` и запрос действительно multimodal.

## Примеры

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --mtmd-batch-max-tokens 512
llama-server --model /srv/models/vision.gguf --mmproj /srv/models/mmproj-F16.gguf --mtmd-batch-max-tokens 2048
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
