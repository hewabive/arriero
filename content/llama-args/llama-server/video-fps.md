---
schema: 1
primaryName: "--video-fps"
title: "--video-fps"
summary: "Задаёт частоту кадров, с которой ffmpeg выбирает frames для multimodal video input. Больше FPS даёт модели больше временных деталей, но увеличивает число image tokens, prefill и потребление контекста."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--video-fps"
allowedValues: []
env:
  - "LLAMA_ARG_VIDEO_FPS"
related:
  - "--video-timestamp-interval"
  - "--video-ffmpeg-dir"
  - "--mtmd-batch-max-tokens"
  - "--image-max-tokens"
  - "--ctx-size"
---

# --video-fps

## Кратко

`--video-fps N` задаёт целевую частоту выборки video frames перед их кодированием multimodal projector. По умолчанию server просит `4.0` frame/s; значение не меняет частоту генерации текста.

Каждый выбранный frame превращается в multimodal input, поэтому FPS — прямой регулятор детализации, длины prompt и стоимости prefill.

## Оригинальная справка llama.cpp

```text
target video frame rate (default: 4.0)
```

## Паспорт аргумента

- Основное имя: `--video-fps`
- Формат: число с плавающей точкой
- Переменная окружения: `LLAMA_ARG_VIDEO_FPS`
- Поле: `common_params::video_fps`
- Значение по умолчанию: `4.0`
- Этап применения: ffprobe исходного video, затем ffmpeg frame filter до mtmd encoding

## Что меняет в llama-server

Server передаёт значение в `mtmd_helper_video_init_params::fps_target`. После ffprobe helper выбирает эффективный FPS: положительное значение берётся как target, неположительное — заменяется native FPS файла. ffmpeg запускается с filter `fps=<effective value>` и отдаёт RGB24 frames в mtmd.

Оценочное число frames вычисляется как `duration × effective_fps` с округлением. Реальные frames затем по очереди кодируются projector-ом и вставляются в prompt.

## Значения и формат

- Положительное число: явный target FPS, допускаются дробные значения.
- `0` или отрицательное число: использовать native FPS video.
- По умолчанию: `4.0` FPS.

Использование native FPS у обычного 30/60 FPS video способно многократно увеличить input; это не форма «выключить video sampling».

## Когда использовать

Уменьшайте FPS для длинных роликов, статичных сцен и при нехватке context/времени prefill. Увеличивайте только если короткие события между sampled frames действительно важны для задачи и модель способна обработать получившийся объём.

Перед production-настройкой измеряйте на типичной длительности video: одинаковый FPS даёт пропорционально больше frames на длинном входе.

## Влияние на производительность и память

Число frames растёт примерно линейно с FPS. Вместе с ним растут CPU cost ffmpeg, работа multimodal projector, image tokens, prefill latency и занятость KV cache. Высокий FPS может превысить slot context ещё до начала generation.

Флаг не меняет размер weights, но повышает пиковые рабочие buffers и длительность обработки media.

## Взаимодействие с другими аргументами

- `--video-timestamp-interval` вставляет text timestamps между выбранными frames; его шкала остаётся временем исходного ролика.
- `--video-ffmpeg-dir` определяет, какие `ffmpeg` и `ffprobe` выполняются.
- `--mtmd-batch-max-tokens` ограничивает размер batch при кодировании media, но не сокращает число frames.
- `--image-min-tokens`/`--image-max-tokens` влияют на tokens одного динамически масштабируемого изображения/frame для поддерживающих это vision models.
- `--ctx-size` и per-slot лимиты должны вместить текст, video tokens и запас на output.

## INI-пресеты и router-режим

```ini
[video-model]
video-fps = 2.0
```

Выбирайте FPS per model и workload: разные vision encoders создают разное число tokens на frame.

## Типовые проблемы и диагностика

- Prompt не помещается в context: уменьшите FPS или длительность video.
- Модель пропускает короткое событие: увеличьте FPS умеренно и сравните число обработанных frames.
- Обработка неожиданно очень медленная при `0`: используется native FPS, а не нулевая частота.
- `ffprobe failed`/`failed to start ffmpeg`: проблема относится к наличию binaries или формату input, а не к projector.

## Примеры

```bash
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --video-fps 2.0
LLAMA_ARG_VIDEO_FPS=1.5 llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/mtmd/mtmd-helper.cpp`
- `llama.cpp/tools/mtmd/mtmd-helper.h`
- https://github.com/ggml-org/llama.cpp/pull/24318
