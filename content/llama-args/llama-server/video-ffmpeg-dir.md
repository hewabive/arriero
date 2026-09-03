---
schema: 1
primaryName: "--video-ffmpeg-dir"
title: "--video-ffmpeg-dir"
summary: "Указывает каталог, в котором llama-server ищет `ffmpeg` и `ffprobe` для video input и fallback-декодирования WebP. Без флага оба executable разрешаются через `PATH`."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "DIR"
aliases:
  - "--video-ffmpeg-dir"
allowedValues: []
env:
  - "LLAMA_ARG_VIDEO_FFMPEG_DIR"
related:
  - "--video-fps"
  - "--video-timestamp-interval"
  - "--media-path"
---

# --video-ffmpeg-dir

## Кратко

`--video-ffmpeg-dir DIR` задаёт общий каталог для `ffmpeg` и `ffprobe`, которые mtmd запускает отдельными subprocess-ами при обработке video. Если каталог не задан, используются имена binaries без пути и поиск выполняется через `PATH` процесса `llama-server`.

Это выбор toolchain, а не каталог входных media-файлов.

## Оригинальная справка llama.cpp

```text
path to the directory containing ffmpeg and ffprobe (default: search in PATH)
```

## Паспорт аргумента

- Основное имя: `--video-ffmpeg-dir`
- Формат: путь к каталогу
- Переменная окружения: `LLAMA_ARG_VIDEO_FFMPEG_DIR`
- Поле: `common_params::video_ffmpeg_bin_dir`
- Значение по умолчанию: пустая строка, поиск через `PATH`
- Этап применения: построение путей и запуск ffprobe/ffmpeg при первом media input

## Что меняет в llama-server

Helper дописывает к `DIR` имена `ffmpeg` и `ffprobe` с platform separator; на Windows также добавляется `.exe`. Затем ffprobe читает параметры video, а ffmpeg декодирует выбранные frames в RGB24.

Существование каталога и binaries не проверяется при старте server. Ошибка проявляется только при обработке video или WebP, которому потребовался ffmpeg fallback.

## Значения и формат

Передавайте каталог, содержащий оба executable, а не путь к одному бинарнику. Завершающий `/` или `\\` необязателен. Пустое значение эквивалентно поиску через `PATH`.

Процесс наследует environment при запуске subprocess, поэтому codecs и поведение определяются выбранной сборкой ffmpeg.

## Когда использовать

Флаг нужен для hermetic deployment, нескольких версий ffmpeg на хосте или service/container environment с урезанным `PATH`. Закрепляйте каталог на проверенную сборку с нужными codecs и обновляйте её как отдельную зависимость.

## Влияние на производительность и память

Сам путь ресурсов не потребляет. Выбранная сборка ffmpeg может отличаться по codec support, CPU acceleration и скорости декодирования; subprocess и RGB frame buffers используют CPU/RAM независимо от основной LLM.

## Взаимодействие с другими аргументами

- `--video-fps` передаёт выбранному ffmpeg target frame rate.
- `--video-timestamp-interval` обрабатывается в mtmd после декодирования.
- `--media-path` разрешает локальные input-файлы из API; он не указывает место binaries.
- Video support должен быть собран с `MTMD_VIDEO`; путь к binaries не включает отключённую compile-time возможность.

## INI-пресеты и router-режим

```ini
[video-model]
video-ffmpeg-dir = /opt/ffmpeg/bin
```

В router/service deployment убедитесь, что child process видит этот же абсолютный путь.

## Типовые проблемы и диагностика

- `failed to launch ffprobe` или `ffprobe failed ... is ffprobe in PATH?`: проверьте наличие обоих binaries и права execute.
- `failed to start ffmpeg`: ffprobe найден, но второй executable отсутствует либо media/codec не поддерживается.
- `video is not supported in this build`: `MTMD_VIDEO` отключён; смена каталога это не исправит.
- Работает из shell, но не из arriero/service: сравните `PATH` и filesystem namespace процесса, либо задайте абсолютный каталог.

## Примеры

```bash
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --video-ffmpeg-dir /opt/ffmpeg/bin
LLAMA_ARG_VIDEO_FFMPEG_DIR=/opt/ffmpeg/bin llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/mtmd/CMakeLists.txt`
- `llama.cpp/tools/mtmd/mtmd-helper.cpp`
- `llama.cpp/tools/mtmd/mtmd-helper.h`
- https://github.com/ggml-org/llama.cpp/pull/24318
