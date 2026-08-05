---
schema: 1
primaryName: "--vision-gemma-4b-default"
title: "--vision-gemma-4b-default"
summary: "Встроенный пресет для Gemma 3 4B IT QAT vision. Задает HF repo, порт 8014, auto context и включает Jinja."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--vision-gemma-4b-default"
allowedValues: []
env: []
related:
  - "--hf-repo"
  - "--hf-file"
  - "--mmproj"
  - "--mmproj-auto"
  - "--port"
  - "--ctx-size"
  - "--jinja"
  - "--image-min-tokens"
  - "--image-max-tokens"
---

# --vision-gemma-4b-default

## Кратко

`--vision-gemma-4b-default` применяет встроенный пресет для `gemma-3-4b-it-qat-GGUF`. Он включает Jinja и оставляет context size автоматическим.

## Оригинальная справка llama.cpp

```text
use Gemma 3 4B QAT (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--vision-gemma-4b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели и multimodal projector
- Область: `llama-server`, `llama-cli`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/gemma-3-4b-it-qat-GGUF"`
- `params.port = 8014`
- `params.n_ctx = 0`
- `params.use_jinja = true`

`hf_file` и `mmproj` напрямую не задаются. Для `--hf-repo` в llama.cpp действует общая логика выбора файла и автоматической загрузки `mmproj`, если он доступен и не отключен `--no-mmproj`.

## Значения и формат

```bash
llama-server --vision-gemma-4b-default
```

INI:

```ini
[gemma-vision-4b]
vision-gemma-4b-default = true
alias = vision-small
tags = vision,gemma
```

## Когда использовать

Используйте для multimodal Gemma 3 4B сервера, когда нужна более легкая vision модель. Это быстрый shortcut для проверки image-capable endpoint.

## Влияние на производительность и память

4B QAT легче 12B варианта, но multimodal запросы требуют память под text model, `mmproj` и image tokens. `n_ctx = 0` может выбрать контекст автоматически; ограничивайте `--ctx-size`, если нужно контролировать KV-cache.

`--image-min-tokens` и `--image-max-tokens` могут влиять на token budget для vision моделей с dynamic resolution.

## Взаимодействие с другими аргументами

`--mmproj-auto`/default HF behavior важны для image input. Если projector не найден, модель может появиться без vision capability. В router `/models` поле `architecture.input_modalities` покажет наличие `image`.

Флаг включает `--jinja`; если задаете `--chat-template`, проверяйте совместимость с Gemma.

## INI-пресеты и router-режим

```ini
[gemma-vision-4b]
vision-gemma-4b-default = true
alias = vision
tags = vision,small
```

При `GET /models` router пытается определить multimodal capability offline по модели и `mmproj`.

## Типовые проблемы и диагностика

- В `/models` нет `image` в `input_modalities`: проверьте загрузку `mmproj`.
- Скачался не тот файл: shortcut задает repo, но не `hf_file`; зафиксируйте `hf-file`.
- Порт `8014` занят: задайте `--port`.
- Vision запрос занимает слишком много контекста: настройте image token limits и `--ctx-size`.

## Примеры

```bash
llama-server --vision-gemma-4b-default --port 8084
```

```bash
llama-server --vision-gemma-4b-default --ctx-size 32768 --image-max-tokens 1024
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--vision-gemma-4b-default`, help `--hf-repo`.
- `llama.cpp/tools/server/server-models.cpp`: router multimodal capability detection.
- `llama.cpp/tools/server/README.md`: multimodal API note и built-in preset help.
