---
schema: 1
primaryName: "--model-vocoder"
title: "--model-vocoder"
summary: "Задает локальный GGUF-файл vocoder-модели для audio generation/TTS. Это отдельная модель от основного `--model` и от multimodal projector `--mmproj`."
category: "Параметры llama-server"
valueType: "path"
valueHint: "FNAME"
aliases:
  - "-mv"
  - "--model-vocoder"
allowedValues: []
env: []
related:
  - "--hf-repo-v"
  - "--hf-file-v"
  - "--hf-token"
  - "--tts-use-guide-tokens"
  - "--model"
---

# --model-vocoder

## Кратко

`--model-vocoder` задает локальный путь к vocoder GGUF для аудио generation/TTS. Значение записывается в `common_params.vocoder.model.path` и обрабатывается через общий механизм `common_params_handle_model()` вместе с HF/URL вариантами vocoder model.

Это не основной LLM и не `mmproj`: `--model` отвечает за text/multimodal backbone, `--mmproj` - за projector для multimodal input, а vocoder - за аудио-выход в TTS pipeline.

## Оригинальная справка llama.cpp

```text
vocoder model for audio generation (default: unused)
```

## Паспорт аргумента

- Основное имя: `--model-vocoder`
- Алиасы: `-mv`, `--model-vocoder`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `path`
- Подсказка формата из `--help`: `FNAME`
- Переменные окружения: не указаны
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.vocoder.model.path`

## Что меняет в llama-server

На парсинге CLI путь сохраняется в `params.vocoder.model.path`. При `common_params_handle_models()` vocoder обрабатывается отдельным вызовом `common_params_handle_model(params.vocoder.model, params.hf_token, params.offline)`.

Если задан только локальный путь, он остается как есть. Если вместе с vocoder HF repo используются `--hf-repo-v`/`--hf-file-v`, downloader может заменить путь на файл из HF cache.

## Значения и формат

Ожидается путь к локальному GGUF-файлу vocoder model. Для управляемого сервиса используйте абсолютный путь и проверьте права чтения.

Если vocoder хранится в HF repo, используйте `--hf-repo-v` и при необходимости `--hf-file-v`, а не прямой локальный путь.

## Когда использовать

Используйте `--model-vocoder`, когда vocoder уже подготовлен локально и запуск должен быть независим от сети. Это предпочтительно для production и offline-развертываний.

Не добавляйте vocoder к обычному text-only серверу без TTS/audio generation сценария: это лишняя модель, память и время старта.

## Влияние на производительность и память

Vocoder увеличивает memory footprint и может добавить время старта. Runtime-влияние проявляется на аудио generation/TTS запросах; обычные text completions не становятся быстрее от наличия vocoder.

## Взаимодействие с другими аргументами

- `--hf-repo-v`/`--hf-file-v`: удаленный вариант выбора vocoder.
- `--hf-token`: используется, если vocoder скачивается из HF.
- `--offline`: для HF vocoder требует cache; для локального `--model-vocoder` сетевых обращений нет.
- `--tts-use-guide-tokens`: отдельная настройка TTS accuracy, может применяться вместе с vocoder.

## INI-пресеты и router-режим

В INI:

```ini
[tts_local]
model = /srv/models/text.gguf
model-vocoder = /srv/models/vocoder.gguf
```

В router-режиме убедитесь, что путь доступен дочернему процессу и одинаково интерпретируется относительно его CWD. Абсолютные пути предпочтительнее.

## Типовые проблемы и диагностика

- Сервер не стартует: проверьте, что vocoder файл существует и является GGUF.
- Аудио/TTS endpoint падает, text работает: проверьте наличие vocoder и совместимость с выбранным TTS pipeline.
- В логе путь vocoder отличается от ожидаемого: проверьте, не задан ли `--hf-repo-v`.

## Примеры

```bash
llama-server --model /srv/models/text.gguf --model-vocoder /srv/models/vocoder.gguf
```

```bash
llama-server --hf-repo owner/text-GGUF:Q4_K_M --model-vocoder /srv/models/vocoder.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/README.md`
