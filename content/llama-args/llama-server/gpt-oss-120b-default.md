---
schema: 1
primaryName: "--gpt-oss-120b-default"
title: "--gpt-oss-120b-default"
summary: "Встроенный пресет для gpt-oss-120b. Задает HF repo, порт 8013, большой контекст, Jinja и sampling defaults, но не фиксирует hf_file."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--gpt-oss-120b-default"
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

# --gpt-oss-120b-default

## Кратко

`--gpt-oss-120b-default` применяет встроенный пресет для `gpt-oss-120b`. В отличие от 20B shortcut, он задает `hf_repo`, но не задает `hf_file`, поэтому выбор файла остается логике `--hf-repo`.

## Оригинальная справка llama.cpp

```text
use gpt-oss-120b (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--gpt-oss-120b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели
- Область: `llama-server`, `llama-cli`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/gpt-oss-120b-GGUF"`
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

`params.model.hf_file` этот флаг не заполняет.

## Значения и формат

```bash
llama-server --gpt-oss-120b-default
```

INI:

```ini
[gpt-oss-120b]
gpt-oss-120b-default = true
alias = gpt-oss-large
tags = chat,gpt-oss,large
```

## Когда использовать

Используйте только на сервере, где заранее понятны требования 120B модели к памяти, диску и времени загрузки. Для production лучше явно зафиксировать файл через `--hf-file`, если в repo есть несколько вариантов и вам нужен конкретный quant.

## Влияние на производительность и память

Это тяжелый preset. `n_ctx = 262144`, `n_batch = 32768` и 120B веса могут требовать очень большого объема RAM/VRAM. Для router autoload публичного API такой shortcut опасен без жестких лимитов и ручной загрузки.

Sampling defaults совпадают с 20B shortcut: `temp = 1.0`, `top_p = 1.0`, `top_k = 0`, `min_p = 0.01`.

## Взаимодействие с другими аргументами

Так как `hf_file` не задан, `--hf-repo` будет использовать свою логику выбора quant/file. Если нужен конкретный GGUF, добавьте явный `--hf-file` или разверните пресет в INI.

`--models-max` считает каждый loaded router instance как одну модель, но память этого instance может быть очень большой.

## INI-пресеты и router-режим

```ini
[gpt-oss-120b]
gpt-oss-120b-default = true
hf-file = selected-file.gguf
alias = gpt-oss-120b
load-on-startup = false
```

Если нужно переопределить `hf-file`, проверьте итоговый argv в `/models`: порядок рендеринга INI shortcut и отдельных ключей может быть важен. Самый надежный вариант - записать развернутые `hf-repo`, `hf-file`, `ctx-size`, `batch-size` без shortcut.

## Типовые проблемы и диагностика

- Скачался не тот файл: preset не фиксирует `hf_file`; задайте `--hf-file`.
- OOM: уменьшите context/batch или используйте меньший preset.
- Долгое ожидание ответа при autoload: 120B модель загружается по первому запросу.
- Порт `8013` занят: задайте `--port`.

## Примеры

```bash
llama-server --gpt-oss-120b-default --ctx-size 32768 --port 8083
```

```bash
llama-server --models-preset /srv/llama/gpt-oss.ini --models-max 1 --no-models-autoload
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--gpt-oss-120b-default`.
- `llama.cpp/common/arg.cpp`: логика `--hf-repo`/`--hf-file`.
- `llama.cpp/tools/server/server-models.cpp`: router autoload и limits.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
