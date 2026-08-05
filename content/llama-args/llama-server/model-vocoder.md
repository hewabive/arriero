---
schema: 1
primaryName: "--model-vocoder"
title: "--model-vocoder"
summary: "Задает локальный GGUF-файл vocoder-модели для audio generation/TTS. llama-server парсит аргумент, но vocoder не загружает — его использует только отдельный инструмент llama-tts."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
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

Важно: `llama-server` этот аргумент принимает, но нигде не использует — в серверном коде vocoder не загружается, TTS endpoint у сервера нет. Vocoder реально потребляет только отдельный инструмент `llama-tts` (`tools/tts/tts.cpp`).

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

Для `llama-server` задавать аргумент бессмысленно: сервер его игнорирует. Практический сценарий — `llama-tts`, где `--model-vocoder` указывает уже скачанный локальный vocoder и делает запуск независимым от сети.

## Влияние на производительность и память

На память `llama-server` аргумент не влияет: vocoder-модель сервером не загружается, поэтому оценка памяти инстанса полна и без нее. В `llama-tts` vocoder — вторая модель со своим footprint.

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

- Ожидаете TTS от `llama-server` с `--model-vocoder`: сервер vocoder не использует; речевую генерацию делает `llama-tts`.
- В логе путь vocoder отличается от ожидаемого: проверьте, не задан ли `--hf-repo-v`.

## Примеры

```bash
llama-server --model /srv/models/text.gguf --model-vocoder /srv/models/vocoder.gguf
```

```bash
llama-server --hf-repo owner/text-GGUF:Q4_K_M --model-vocoder /srv/models/vocoder.gguf
```

## Статус в upstream

В актуальном checkout аргумент включен для `llama-server` в `common/arg.cpp` (`set_examples`), печатается в `--help` и в сгенерированном help-блоке README, но серверная реализация его не потребляет. Upstream [PR #26254](https://github.com/ggml-org/llama.cpp/pull/26254) убирает серверные vocoder-аргументы целиком; после обновления checkout за эту точку строка исчезнет из `--help`, и этот документ будет удален по штатной процедуре удаленных аргументов.

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/tts/tts.cpp`
- `llama.cpp/tools/server/README.md`
