---
schema: 1
primaryName: "--fim-qwen-7b-default"
title: "--fim-qwen-7b-default"
summary: "Встроенный пресет для Qwen2.5-Coder 7B Q8_0 без draft-модели. Настраивает HF repo/file, порт 8012, batch 1024, auto context и cache reuse."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--fim-qwen-7b-default"
allowedValues: []
env: []
related:
  - "--fim-qwen-7b-spec"
  - "--hf-repo"
  - "--hf-file"
  - "--port"
  - "--batch-size"
  - "--ubatch-size"
  - "--ctx-size"
  - "--cache-reuse"
---

# --fim-qwen-7b-default

## Кратко

`--fim-qwen-7b-default` запускает default Qwen2.5 Coder 7B Q8_0 preset без speculative draft-модели. Для speculative варианта есть отдельный `--fim-qwen-7b-spec`.

## Оригинальная справка llama.cpp

```text
use default Qwen 2.5 Coder 7B (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--fim-qwen-7b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели
- Область: `llama-server`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF"`
- `params.model.hf_file = "qwen2.5-coder-7b-q8_0.gguf"`
- `params.port = 8012`
- `params.n_ubatch = 1024`
- `params.n_batch = 1024`
- `params.n_ctx = 0`
- `params.n_cache_reuse = 256`

## Значения и формат

```bash
llama-server --fim-qwen-7b-default
```

INI:

```ini
[qwen-coder-7b]
fim-qwen-7b-default = true
alias = coder-7b
tags = code,fim,qwen
```

## Когда использовать

Используйте как balanced default для code/FIM задач, когда качество 7B модели нужно больше, чем минимальное потребление памяти 1.5B/3B вариантов.

Если нужен speculative decoding с Qwen2.5-Coder-0.5B draft, используйте `--fim-qwen-7b-spec`.

## Влияние на производительность и память

7B Q8_0 требует существенно больше RAM/VRAM, чем 1.5B и 3B пресеты. Пресет не задает GPU offload, поэтому фактическая скорость зависит от `--n-gpu-layers`, backend и доступной видеопамяти.

`n_ctx = 0` может привести к большому контексту, если модель и runtime выбирают его автоматически; задавайте явный `--ctx-size`, если нужно ограничить память KV-cache.

## Взаимодействие с другими аргументами

Не комбинируйте с `--fim-qwen-7b-spec` в одной команде: оба выбирают основную модель, но spec-вариант добавляет draft. Также избегайте одновременного использования с другим `--hf-repo` или `--model`, если не контролируете порядок аргументов.

`--cache-reuse 256` уже включен пресетом; для workload без повторяющихся префиксов можно переопределить.

## INI-пресеты и router-режим

В router INI:

```ini
[coder-7b]
fim-qwen-7b-default = true
alias = coder
load-on-startup = false
```

При большом числе моделей ограничьте одновременные загрузки через `--models-max`.

## Типовые проблемы и диагностика

- OOM при первом запросе router: модель загружается по autoload; уменьшите `--models-max`, выберите меньшую модель или задайте явный offload.
- Порт `8012` занят в single-model mode: переопределите `--port`.
- Долгая первая генерация: модель скачивается или загружается с диска.

## Примеры

```bash
llama-server --fim-qwen-7b-default --ctx-size 32768 --port 8082
```

```bash
llama-server --models-preset /srv/llama/coders.ini --models-max 1
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--fim-qwen-7b-default`.
- `llama.cpp/tools/server/server-models.cpp`: router загрузка и `--models-max`.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
