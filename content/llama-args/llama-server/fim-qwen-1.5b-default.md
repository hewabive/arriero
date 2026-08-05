---
schema: 1
primaryName: "--fim-qwen-1.5b-default"
title: "--fim-qwen-1.5b-default"
summary: "Встроенный пресет для Qwen2.5-Coder 1.5B Q8_0. Задает HF repo/file, порт 8012, auto context и cache reuse для FIM/code сценариев."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--fim-qwen-1.5b-default"
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

# --fim-qwen-1.5b-default

## Кратко

`--fim-qwen-1.5b-default` применяет встроенный пресет для `Qwen2.5-Coder-1.5B-Q8_0-GGUF`. Пресет ориентирован на code/FIM сервер и может скачать веса из Hugging Face.

## Оригинальная справка llama.cpp

```text
use default Qwen 2.5 Coder 1.5B (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--fim-qwen-1.5b-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки модели
- Область: `llama-server`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF"`
- `params.model.hf_file = "qwen2.5-coder-1.5b-q8_0.gguf"`
- `params.port = 8012`
- `params.n_ubatch = 1024`
- `params.n_batch = 1024`
- `params.n_ctx = 0`
- `params.n_cache_reuse = 256`

`n_ctx = 0` оставляет размер контекста на автоматическое определение по модели и остальным настройкам llama.cpp.

## Значения и формат

Флаг не принимает значение:

```bash
llama-server --fim-qwen-1.5b-default
```

В INI:

```ini
[qwen-coder-1.5b]
fim-qwen-1.5b-default = true
alias = coder-small
tags = code,fim,qwen
```

## Когда использовать

Используйте для быстрого code-completion/FIM инстанса с небольшой Qwen Coder моделью. Это удобный baseline для локального автодополнения, где важны быстрый старт и умеренное потребление памяти.

## Влияние на производительность и память

Модель 1.5B Q8_0 заметно легче 7B/14B вариантов. `n_batch = n_ubatch = 1024` ограничивает размер батча, а `n_cache_reuse = 256` включает повторное использование prompt cache chunks для похожих запросов.

Память зависит от выбранного backend и `--n-gpu-layers`, который этот пресет не задает.

## Взаимодействие с другими аргументами

Флаг задает модель через `--hf-repo`/`--hf-file`; не смешивайте его с другим `--model` или `--hf-repo`, если не проверили порядок аргументов. Для явного локального файла используйте развернутую конфигурацию без shortcut.

`--spm-infill` может быть нужен для моделей, предпочитающих Suffix/Prefix/Middle infill pattern; сам пресет его не включает.

## INI-пресеты и router-режим

В router mode shortcut можно использовать как модельную секцию. Добавьте `load-on-startup = true`, если модель должна быть поднята сразу.

```ini
[coder-small]
fim-qwen-1.5b-default = true
alias = coder
load-on-startup = true
```

## Типовые проблемы и диагностика

- Неожиданная загрузка из интернета: используйте cache заранее или локальный `model = ...`.
- Порт `8012` занят в single-model mode: задайте `--port` после флага.
- Контекст не тот, что ожидался: пресет ставит `ctx-size = 0`; задайте явный `--ctx-size`.
- В router запрос не находит `coder`: проверьте alias в `/models`.

## Примеры

```bash
llama-server --fim-qwen-1.5b-default --port 8082
```

```bash
llama-server --models-preset /srv/llama/coders.ini --models-max 1
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--fim-qwen-1.5b-default`.
- `llama.cpp/common/preset.cpp`: использование shortcut в INI.
- `llama.cpp/tools/server/README.md`: список встроенных пресетов.
