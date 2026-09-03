---
schema: 1
primaryName: "--video-timestamp-interval"
title: "--video-timestamp-interval"
summary: "Задаёт интервал в миллисекундах между text timestamps, которые mtmd вставляет в video prompt. Значение `0` или меньше отключает timestamps; default — 5000 ms."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--video-timestamp-interval"
allowedValues: []
env:
  - "LLAMA_ARG_VIDEO_TIMESTAMP_INTERVAL"
related:
  - "--video-fps"
  - "--video-ffmpeg-dir"
  - "--ctx-size"
---

# --video-timestamp-interval

## Кратко

`--video-timestamp-interval N` управляет частотой текстовых отметок времени внутри подготовленного video prompt. По умолчанию mtmd добавляет отметку каждые 5000 ms, чтобы модель могла связывать visual frames с позицией в ролике.

Флаг не меняет число извлечённых frames — этим занимается `--video-fps`.

## Оригинальная справка llama.cpp

```text
interval in milliseconds between text timestamps (default: 5000)
```

## Паспорт аргумента

- Основное имя: `--video-timestamp-interval`
- Формат: целое число миллисекунд
- Переменная окружения: `LLAMA_ARG_VIDEO_TIMESTAMP_INTERVAL`
- Поле: `common_params::video_timestamp_interval_ms`
- Значение по умолчанию: `5000`
- Этап применения: преобразование декодированных video frames в последовательность text/image chunks

## Что меняет в llama-server

После чтения frame helper вычисляет его elapsed time как `frame_index / effective_fps`. При достижении очередного порога он ставит в очередь text chunk формата `[<minutes>m<seconds>s]`, который возвращается перед следующим frame.

Отметки становятся частью input prompt и доступны vision-language model как обычный текст. Они не являются полем HTTP response и не меняют timestamps самого media container.

## Значения и формат

- Положительное `N`: интервал между порогами в миллисекундах.
- `0` или отрицательное значение: не добавлять timestamps.
- Default `5000`: примерно одна отметка каждые пять секунд исходного video.

Очень маленькое значение не создаёт больше одной отметки на каждый прочитанный frame: частота фактически ограничена `--video-fps`.

## Когда использовать

Оставляйте default для вопросов о последовательности событий и времени. Уменьшайте интервал, если нужна более точная временная привязка и FPS достаточно высок. Отключайте timestamps, если chat template/model не обучены на таком текстовом формате или важнее минимизировать дополнительные text tokens.

## Влияние на производительность и память

Флаг не меняет video decoding или projector compute. Более частые timestamps добавляют небольшое число text tokens, увеличивая prompt, prefill и KV-cache usage. По сравнению с ростом `--video-fps` стоимость обычно мала.

## Взаимодействие с другими аргументами

- `--video-fps` определяет временную сетку frames и тем самым точность, с которой может сработать заданный interval.
- `--ctx-size` должен вместить добавленные timestamps вместе с media tokens.
- `--video-ffmpeg-dir` влияет только на запуск binaries и не меняет формат отметок.

## INI-пресеты и router-режим

```ini
[video-model]
video-timestamp-interval = 10000
```

Для model preset фиксируйте значение вместе с FPS: смысл interval зависит от плотности frames.

## Типовые проблемы и диагностика

- Timestamps отсутствуют: проверьте, что значение положительное и input действительно распознан как video.
- Меток меньше ожидаемого: FPS слишком низок, поэтому между frames перескакиваются несколько временных порогов.
- Ответ модели буквально повторяет служебные отметки: увеличьте interval либо отключите их для несовместимой модели/template.
- Prompt вырос: используйте `0`, если временная привязка не нужна.

## Примеры

```bash
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --video-timestamp-interval 10000
llama-server --model /models/vision.gguf --mmproj /models/mmproj.gguf --video-timestamp-interval 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/mtmd/mtmd-helper.cpp`
- `llama.cpp/tools/mtmd/mtmd-helper.h`
- https://github.com/ggml-org/llama.cpp/pull/24318
