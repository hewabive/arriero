---
schema: 1
primaryName: "--mmproj-auto"
title: "--mmproj-auto"
summary: "Управляет автоматическим использованием `mmproj`, найденного рядом с HF-моделью. По умолчанию включено; отрицательные формы `--no-mmproj` и `--no-mmproj-auto` запрещают projector."
category: "Параметры llama-server"
valueType: "flag"
valueHint: null
aliases:
  - "--mmproj-auto"
  - "--no-mmproj"
  - "--no-mmproj-auto"
allowedValues: []
env:
  - "LLAMA_ARG_MMPROJ_AUTO"
related:
  - "--hf-repo"
  - "--mmproj"
  - "--mmproj-url"
  - "--mmproj-offload"
---

# --mmproj-auto

## Кратко

`--mmproj-auto` включает автоматическое использование projector, который downloader находит рядом с HF-моделью. В проверенном commit это поведение включено по умолчанию, а `--no-mmproj` или `--no-mmproj-auto` выставляют `params.no_mmproj = true`.

## Оригинальная справка llama.cpp

```text
whether to use multimodal projector file (if available), useful when using -hf (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--mmproj-auto`
- Положительная форма: `--mmproj-auto`
- Отрицательные формы: `--no-mmproj`, `--no-mmproj-auto`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `flag`
- Переменные окружения: `LLAMA_ARG_MMPROJ_AUTO`
- Значение по умолчанию: enabled
- Внутреннее поле: `common_params.no_mmproj` с инверсной логикой

## Что меняет в llama-server

CLI handler получает bool `value` от положительной или отрицательной формы и записывает `params.no_mmproj = !value`. После обработки основной модели:

- если `params.no_mmproj` true, `params.mmproj` очищается;
- иначе, если HF downloader нашел `mmproj` и явные `--mmproj`/`--mmproj-url` пусты, найденный путь записывается в `params.mmproj`;
- затем для server/mtmd example projector скачивается/обрабатывается и позже загружается в `server_context::load_model()`.

## Значения и формат

В CLI используйте флаг без значения:

- `--mmproj-auto` - включить auto behavior;
- `--no-mmproj` или `--no-mmproj-auto` - отключить.

Для INI/preset boolean-ключей используйте обычный формат preset parser; для отрицания в README указан `no-` prefix.

## Когда использовать

Оставляйте default, если запускаете vision/multimodal HF repo и хотите, чтобы projector подхватился автоматически. Используйте `--no-mmproj`, если нужен text-only запуск той же модели, если auto-подбор выбирает несовместимый projector или если вы хотите явно указать другой `--mmproj`.

## Влияние на производительность и память

Включенный auto projector может добавить скачивание, память и preprocessing. Отключение projector уменьшает footprint, но server перестает поддерживать multimodal input для этой модели.

## Взаимодействие с другими аргументами

- `--hf-repo`: основной сценарий auto-поиска `mmproj`.
- `--mmproj` и `--mmproj-url`: явные значения имеют практический приоритет, если `--no-mmproj` не очищает `params.mmproj`.
- `--mmproj-offload`: влияет только если projector реально загружен.
- `--image-min-tokens`/`--image-max-tokens`: применимы только при loaded `mmproj`.

## INI-пресеты и router-режим

Примеры:

```ini
[vision_auto]
hf-repo = ggml-org/gemma-3-4b-it-GGUF:Q8_0
mmproj-auto = true

[text_only_same_repo]
hf-repo = ggml-org/gemma-3-4b-it-GGUF:Q8_0
no-mmproj = true
```

В router-режиме auto projector удобен для HF cache моделей, но для локального `--models-dir` README рекомендует класть `mmproj*.gguf` рядом с моделью в подкаталоге.

## Типовые проблемы и диагностика

- Multimodal неожиданно включился: проверьте, не найден ли `mmproj` автоматически при `--hf-repo`.
- Multimodal не включился: проверьте отсутствие `--no-mmproj` и наличие `mmproj` в repo/cache.
- Нужен другой projector: задайте явный `--mmproj` и не используйте `--no-mmproj`.

## Примеры

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0
```

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --no-mmproj
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
