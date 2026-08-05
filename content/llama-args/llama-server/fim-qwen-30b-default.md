---
schema: 1
primaryName: "--fim-qwen-30b-default"
title: "--fim-qwen-30b-default"
summary: "Встроенный пресет для Qwen3-Coder-30B-A3B-Instruct Q8_0. Задает HF repo/file, порт 8012, batch 1024, auto context и cache reuse."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--fim-qwen-30b-default"
allowedValues: []
env: []
related:
  - "--hf-repo"
  - "--hf-file"
  - "--port"
  - "--batch-size"
  - "--ubatch-size"
  - "--ctx-size"
  - "--cache-reuse"
---

# --fim-qwen-30b-default

## Кратко

`--fim-qwen-30b-default` применяет встроенный пресет для `Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF`. Несмотря на имя аргумента `fim-qwen`, в коде это Qwen3 Coder 30B A3B Instruct, а не Qwen2.5 Coder.

## Оригинальная справка llama.cpp

```text
use default Qwen 3 Coder 30B A3B Instruct (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--fim-qwen-30b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели
- Область: `llama-server`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF"`
- `params.model.hf_file = "qwen3-coder-30b-a3b-instruct-q8_0.gguf"`
- `params.port = 8012`
- `params.n_ubatch = 1024`
- `params.n_batch = 1024`
- `params.n_ctx = 0`
- `params.n_cache_reuse = 256`

## Значения и формат

```bash
llama-server --fim-qwen-30b-default
```

INI:

```ini
[qwen3-coder-30b]
fim-qwen-30b-default = true
alias = coder-30b
tags = code,qwen3
```

## Когда использовать

Используйте для более сильной Qwen3 Coder конфигурации, когда доступна достаточная память и нужен instruct/code уровень выше малых Qwen2.5 Coder пресетов.

Для ограниченной VRAM сначала проверьте меньшие модели или другой quant через явные `--hf-repo`/`--hf-file`.

## Влияние на производительность и память

30B A3B Instruct Q8_0 может быть тяжелым по диску, RAM и VRAM. Пресет не задает `--n-gpu-layers`, поэтому без явного offload часть работы может уйти на CPU в зависимости от default backend.

`n_ctx = 0` оставляет выбор context runtime; при OOM задайте явный меньший `--ctx-size`.

## Взаимодействие с другими аргументами

Флаг задает только target-модель и batch/cache параметры. Он не включает speculative decoding и не задает chat template. Для router задавайте alias/tags в INI.

Если хотите использовать другую quantization, не используйте shortcut; задайте `--hf-repo` и `--hf-file` напрямую.

## INI-пресеты и router-режим

```ini
[coder-30b]
fim-qwen-30b-default = true
alias = coder-large
load-on-startup = false
stop-timeout = 30
```

При autoload такая модель может вытеснять меньшие модели по LRU, если `--models-max` достигнут.

## Типовые проблемы и диагностика

- OOM или долгий старт: это тяжелый preset; проверьте `--ctx-size`, offload и `--models-max`.
- Порт `8012` занят: задайте `--port`.
- Клиент ожидает FIM-only поведение: модель называется Qwen3 Coder Instruct; проверяйте endpoint и prompt format.

## Примеры

```bash
llama-server --fim-qwen-30b-default --ctx-size 32768 --port 8082
```

```bash
llama-server --models-preset /srv/llama/coders.ini --no-models-autoload
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--fim-qwen-30b-default`.
- `llama.cpp/tools/server/server-models.cpp`: router autoload/LRU.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
