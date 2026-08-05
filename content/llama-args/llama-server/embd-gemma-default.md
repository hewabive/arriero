---
schema: 1
primaryName: "--embd-gemma-default"
title: "--embd-gemma-default"
summary: "Встроенный пресет для EmbeddingGemma 300M QAT Q4_0. Настраивает HF repo/file, embedding mode, порт 8011 и параметры batch/parallel/context."
category: "Параметры llama-server"
valueType: "flag"
estimation: "preset-rewrite"
valueHint: null
aliases:
  - "--embd-gemma-default"
allowedValues: []
env: []
related:
  - "--embedding"
  - "--hf-repo"
  - "--hf-file"
  - "--port"
  - "--batch-size"
  - "--ubatch-size"
  - "--parallel"
  - "--ctx-size"
  - "--verbose"
---

# --embd-gemma-default

## Кратко

`--embd-gemma-default` применяет встроенный пресет для EmbeddingGemma и переводит server в embedding use case. Флаг может скачать веса из Hugging Face, если модель еще не находится в cache.

## Оригинальная справка llama.cpp

```text
use default EmbeddingGemma model (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--embd-gemma-default`
- Тип: flag без значения
- Env: нет
- Поле `common_params`: несколько полей `model`, server и embedding настроек
- Этап применения: парсинг CLI, до загрузки модели
- Область: `llama-server`, `llama-embedding`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/embeddinggemma-300M-qat-q4_0-GGUF"`
- `params.model.hf_file = "embeddinggemma-300M-qat-Q4_0.gguf"`
- `params.port = 8011`
- `params.n_ubatch = 2048`
- `params.n_batch = 2048`
- `params.n_parallel = 32`
- `params.n_ctx = 2048 * params.n_parallel`, то есть `65536`
- `params.verbose_prompt = true`
- `params.embedding = true`

Это не alias и не router catalog entry. Это shortcut, который заполняет те же поля, что можно было бы задать обычными аргументами.

## Значения и формат

Флаг не принимает значение:

```bash
llama-server --embd-gemma-default
```

В INI-пресете router его можно записать как boolean:

```ini
[embeddinggemma]
embd-gemma-default = true
alias = embeddings
tags = embedding,gemma
```

## Когда использовать

Используйте для быстрого запуска EmbeddingGemma endpoint без ручного подбора `--hf-repo`, `--embedding`, `--batch-size`, `--ubatch-size`, `--parallel` и `--ctx-size`.

Не используйте этот флаг для chat/completions: он включает embedding-only режим, предназначенный для embedding endpoint и embedding-моделей.

## Влияние на производительность и память

`n_parallel = 32` и `n_ctx = 65536` рассчитаны на параллельную обработку embedding запросов. Это может увеличить память под контекст по сравнению с маленьким single-slot сервером, но embedding-модель сама по себе небольшая.

`n_batch = n_ubatch = 2048` избегает предупреждения server о том, что embeddings требуют обработать batch в одном ubatch.

## Взаимодействие с другими аргументами

Флаг задает `--hf-repo`, `--hf-file`, `--port`, `--embedding`, `--batch-size`, `--ubatch-size`, `--parallel`, `--ctx-size` и `--verbose`. Если нужны другие значения, задавайте явные аргументы после пресета в CLI и проверяйте итоговый argv в логах.

В router mode лучше задавать alias/tags в `--models-preset`; сам router при запуске дочернего процесса перезапишет `--alias` canonical name.

## INI-пресеты и router-режим

В `--models-preset` этот флаг может описывать модель:

```ini
[embeddinggemma]
embd-gemma-default = true
load-on-startup = true
stop-timeout = 20
```

Если нужно точно переопределять параметры batch/context внутри того же INI, надежнее не смешивать shortcut и переопределения, а записать развернутый набор ключей вручную.

## Типовые проблемы и диагностика

- Сервер скачивает модель: это ожидаемо при отсутствии cache и доступной сети.
- Chat endpoint ведет себя не как chat-модель: включен `--embedding`.
- Порт занят: пресет ставит `8011`; задайте другой `--port` после флага.
- В router модель не загружается при старте: добавьте `load-on-startup = true` в модельную секцию.

## Примеры

```bash
llama-server --embd-gemma-default --port 8081
```

```bash
llama-server --models-preset /srv/llama/embeddings.ini --models-max 1
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--embd-gemma-default`.
- `llama.cpp/tools/server/server.cpp`: проверка batch для embeddings.
- `llama.cpp/common/preset.cpp`: boolean flag в INI и рендеринг `to_args`.
- `llama.cpp/tools/server/README.md`: help-строка встроенного пресета.
