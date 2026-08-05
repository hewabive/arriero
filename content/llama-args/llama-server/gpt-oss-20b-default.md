---
schema: 1
primaryName: "--gpt-oss-20b-default"
title: "--gpt-oss-20b-default"
summary: "Встроенный пресет для gpt-oss-20b MXFP4. Задает HF repo/file, порт 8013, большой контекст, Jinja и sampling defaults."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--gpt-oss-20b-default"
allowedValues: []
env: []
related:
  - "--hf-repo"
  - "--hf-file"
  - "--port"
  - "--batch-size"
  - "--ubatch-size"
  - "--parallel"
  - "--ctx-size"
  - "--jinja"
  - "--temp"
  - "--top-p"
  - "--top-k"
  - "--min-p"
---

# --gpt-oss-20b-default

## Кратко

`--gpt-oss-20b-default` применяет встроенный пресет для `gpt-oss-20b` и задает параметры server, sampling и Jinja template mode. Флаг может скачать веса из Hugging Face.

## Оригинальная справка llama.cpp

```text
use gpt-oss-20b (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--gpt-oss-20b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели и chat template
- Область: `llama-server`, `llama-cli`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/gpt-oss-20b-GGUF"`
- `params.model.hf_file = "gpt-oss-20b-mxfp4.gguf"`
- `params.port = 8013`
- `params.n_ubatch = 2048`
- `params.n_batch = 32768`
- `params.n_parallel = 2`
- `params.n_ctx = 131072 * params.n_parallel`, то есть `262144`
- `params.sampling.temp = 1.0`
- `params.sampling.top_p = 1.0`
- `params.sampling.top_k = 0`
- `params.sampling.min_p = 0.01`
- `params.use_jinja = true`

## Значения и формат

```bash
llama-server --gpt-oss-20b-default
```

INI:

```ini
[gpt-oss-20b]
gpt-oss-20b-default = true
alias = gpt-oss
tags = chat,gpt-oss
```

## Когда использовать

Используйте для быстрого запуска gpt-oss-20b с теми sampling и context defaults, которые зашиты в llama.cpp. Это shortcut для chat/instruct сценариев, где нужен Jinja template engine.

## Влияние на производительность и память

`n_ctx = 262144`, `n_batch = 32768` и `n_parallel = 2` могут заметно увеличить память под KV-cache и batch buffers. Если сервер падает по памяти, первым делом уменьшайте `--ctx-size` и `--batch-size`.

`top_k = 0`, `top_p = 1.0`, `temp = 1.0`, `min_p = 0.01` меняют качество/стохастику генерации, но не загрузку весов.

## Взаимодействие с другими аргументами

Флаг задает `--jinja`, поэтому если нужен другой template режим, укажите явные chat-template/Jinja аргументы и проверьте итоговый лог.

Для router mode задавайте alias/tags в `--models-preset`. Не смешивайте этот shortcut с другим `--hf-repo` или `--model` в одной секции.

## INI-пресеты и router-режим

```ini
[gpt-oss-20b]
gpt-oss-20b-default = true
alias = gpt-oss-20b
load-on-startup = false
stop-timeout = 30
```

При большом context этот preset лучше держать за `--no-models-autoload` и загружать явно.

## Типовые проблемы и диагностика

- OOM на старте или первом запросе: уменьшите `--ctx-size`, `--batch-size`, `--parallel` или offload.
- Порт `8013` занят: задайте `--port`.
- Непривычная генерация: проверьте sampling defaults, особенно `top_k = 0` и `min_p = 0.01`.
- Скачивается `gpt-oss-20b-mxfp4.gguf`: это точный `hf_file`, заданный preset.

## Примеры

```bash
llama-server --gpt-oss-20b-default --ctx-size 65536 --port 8083
```

```bash
llama-server --models-preset /srv/llama/gpt-oss.ini --no-models-autoload
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--gpt-oss-20b-default`.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
- `llama.cpp/common/preset.cpp`: INI shortcut handling.
