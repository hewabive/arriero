---
schema: 1
primaryName: "--fim-qwen-3b-default"
title: "--fim-qwen-3b-default"
summary: "Встроенный пресет для Qwen2.5-Coder 3B Q8_0. Задает HF repo/file, порт 8012, batch 1024, auto context и cache reuse 256."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--fim-qwen-3b-default"
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

# --fim-qwen-3b-default

## Кратко

`--fim-qwen-3b-default` применяет встроенный пресет для `Qwen2.5-Coder-3B-Q8_0-GGUF`. Это средний по размеру default из Qwen2.5 Coder FIM shortcut-группы.

## Оригинальная справка llama.cpp

```text
use default Qwen 2.5 Coder 3B (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--fim-qwen-3b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели
- Область: `llama-server`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF"`
- `params.model.hf_file = "qwen2.5-coder-3b-q8_0.gguf"`
- `params.port = 8012`
- `params.n_ubatch = 1024`
- `params.n_batch = 1024`
- `params.n_ctx = 0`
- `params.n_cache_reuse = 256`

## Значения и формат

```bash
llama-server --fim-qwen-3b-default
```

INI форма:

```ini
[qwen-coder-3b]
fim-qwen-3b-default = true
alias = coder-3b
tags = code,fim,qwen
```

## Когда использовать

Используйте, когда 1.5B модель слишком слабая, но 7B модель слишком дорогая по памяти или latency. Пресет полезен для локального coding ассистента и FIM endpoint.

## Влияние на производительность и память

По сравнению с 1.5B вариантом модель потребляет больше RAM/VRAM и обычно дает лучшее качество. Пресет не задает `--n-gpu-layers`, поэтому распределение CPU/GPU выбирается отдельными аргументами или backend defaults.

`n_cache_reuse = 256` может помочь при повторяющихся префиксах code-completion запросов.

## Взаимодействие с другими аргументами

Флаг конфликтует по смыслу с другими способами выбора модели: `--model`, `--hf-repo`, `--hf-file` и другими `*-default` shortcut. Используйте один источник модели на секцию или CLI-команду.

Для router alias задавайте через `--models-preset`, а не глобальным `--alias`.

## INI-пресеты и router-режим

Shortcut можно использовать в модельной секции router:

```ini
[coder-3b]
fim-qwen-3b-default = true
alias = coder
stop-timeout = 20
```

Для точных переопределений context/batch лучше развернуть пресет вручную.

## Типовые проблемы и диагностика

- Модель скачивается при первом старте: это ожидаемо для HF preset.
- Не хватает памяти: уменьшите GPU offload, используйте меньшую модель или другой quant через явный `--hf-repo`/`--hf-file`.
- Порт `8012` занят: задайте `--port`.

## Примеры

```bash
llama-server --fim-qwen-3b-default --ctx-size 32768 --port 8082
```

```bash
llama-server --models-preset /srv/llama/coders.ini --models-autoload
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--fim-qwen-3b-default`.
- `llama.cpp/common/preset.cpp`: flag в INI.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
