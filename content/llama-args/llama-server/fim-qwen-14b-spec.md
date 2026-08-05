---
schema: 1
primaryName: "--fim-qwen-14b-spec"
title: "--fim-qwen-14b-spec"
summary: "Встроенный пресет Qwen2.5-Coder 14B Q8_0 с Qwen2.5-Coder 0.5B draft-моделью для speculative decoding."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--fim-qwen-14b-spec"
allowedValues: []
env: []
related:
  - "--spec-draft-hf"
  - "--spec-draft-model"
  - "--spec-type"
  - "--spec-default"
  - "--hf-repo"
  - "--hf-file"
  - "--cache-reuse"
---

# --fim-qwen-14b-spec

## Кратко

`--fim-qwen-14b-spec` выбирает Qwen2.5-Coder 14B Q8_0 как target-модель и Qwen2.5-Coder 0.5B Q8_0 как draft-модель. Это самый тяжелый Qwen2.5 Coder speculative shortcut из этой группы.

## Оригинальная справка llama.cpp

```text
use Qwen 2.5 Coder 14B + 0.5B draft for speculative decoding (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--fim-qwen-14b-spec`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки target и draft моделей
- Область: `llama-server`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/Qwen2.5-Coder-14B-Q8_0-GGUF"`
- `params.model.hf_file = "qwen2.5-coder-14b-q8_0.gguf"`
- `params.speculative.draft.mparams.hf_repo = "ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF"`
- `params.speculative.draft.mparams.hf_file = "qwen2.5-coder-0.5b-q8_0.gguf"`
- `params.port = 8012`
- `params.n_ubatch = 1024`
- `params.n_batch = 1024`
- `params.n_ctx = 0`
- `params.n_cache_reuse = 256`

## Значения и формат

```bash
llama-server --fim-qwen-14b-spec
```

INI:

```ini
[coder-14b-spec]
fim-qwen-14b-spec = true
alias = coder-large
tags = code,fim,speculative
```

## Когда использовать

Используйте, когда качество 14B target важнее памяти и времени загрузки, а speculative decoding может окупить дополнительную draft-модель. Для постоянного сервера заранее проверьте фактическое потребление памяти и acceptance rate на ваших prompts.

## Влияние на производительность и память

Память нужна под 14B Q8_0 target, 0.5B Q8_0 draft, их контексты и KV-cache. `n_ctx = 0` может выбрать большой контекст, поэтому для ограниченной VRAM задавайте явный `--ctx-size`.

Speculative decoding может ускорить generation, но не ускоряет загрузку модели и не уменьшает память.

## Взаимодействие с другими аргументами

Для draft-модели используйте `--spec-draft-ngl`, `--spec-draft-device`, `--spec-draft-threads` и типы KV-cache draft. Для target-модели применяются обычные `--n-gpu-layers`, `--device`, `--cache-type-k`, `--cache-type-v`.

Shortcut не выбирает speculative type сам. Добавьте `--spec-type draft-simple`; без него обычная 0.5B draft-модель будет загружена как источник, но draft-simple implementation не активируется.

## INI-пресеты и router-режим

```ini
[coder-14b-spec]
fim-qwen-14b-spec = true
spec-type = draft-simple
alias = coder-14b
stop-timeout = 30
```

В router учитывайте, что `--models-max` считает этот preset как одну модель, хотя дочерний процесс держит две модели.

## Типовые проблемы и диагностика

- `failed to load draft model`: проверьте доступ к HF/cache и draft offload настройки.
- OOM: ограничьте context, offload или используйте 7B/30B другой quant.
- Первый запрос очень долгий: target и draft могут скачиваться и грузиться одновременно.
- Speculative context не инициализирован: ищите в логах `failed to initialize speculative decoding context`.

## Примеры

```bash
llama-server --fim-qwen-14b-spec --spec-type draft-simple --ctx-size 32768 --port 8082
```

```bash
llama-server --fim-qwen-14b-spec --spec-type draft-simple --spec-draft-ngl auto
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--fim-qwen-14b-spec`.
- `llama.cpp/common/speculative.cpp`: speculative config selection.
- `llama.cpp/tools/server/server-context.cpp`: target/draft context loading.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
