---
schema: 1
primaryName: "--rerank"
title: "--rerank"
summary: "Включает reranking endpoint и автоматически настраивает embedding mode с `pooling rank`. Нужна reranker-модель, а не обычная embedding или chat модель."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--rerank"
  - "--reranking"
allowedValues: []
env:
  - "LLAMA_ARG_RERANKING"
related:
  - "--embedding"
  - "--pooling"
---

# --rerank

## Кратко

`--rerank` ставит `common_params::embedding = true` и `common_params::pooling_type = LLAMA_POOLING_TYPE_RANK`. Это shortcut для запуска `/reranking` с reranker model.

Без rank pooling route `/reranking` отвечает ошибкой `This server does not support reranking. Start it with --reranking`.

## Оригинальная справка llama.cpp

```text
enable reranking endpoint on server (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--rerank`
- Алиас: `--reranking`
- Тип: флаг без значения
- Поля `common_params`: `embedding`, `pooling_type`
- Переменная окружения: `LLAMA_ARG_RERANKING`
- По умолчанию: disabled

## Что меняет в llama-server

Route `/reranking` начинает принимать Jina-style body с `query` и `documents` или TEI-style body с `texts`. Для каждого документа server строит rerank prompt через `format_prompt_rerank()`, создает `SERVER_TASK_TYPE_RERANK` и возвращает scores/results.

При создании context llama.cpp проверяет rank pooling prerequisites: BOS token и EOS/SEP/rerank prompt. Если их нет, логирует warnings, что reranking не будет работать.

## Значения и формат

Флаг без значения:

```bash
llama-server --model /models/reranker.gguf --rerank
```

Эквивалентная ручная форма:

```bash
llama-server --model /models/reranker.gguf --embedding --pooling rank
```

## Когда использовать

- Cross-encoder reranker GGUF, например bge-reranker style.
- Retrieval pipeline, где после initial vector search нужно переупорядочить documents по query.

Не используйте с обычной embedding model: rank pooling и prompt format должны поддерживаться моделью/tokenizer.

## Влияние на производительность и память

Reranking создает отдельную task на каждый документ. Latency растет с числом documents; throughput зависит от batching и parallel slots. Поскольку `--rerank` включает embedding mode, server до создания context также прижимает `n_batch` к `n_ubatch`, если batch был больше; Arriero учитывает это в resolved context. Длинные query/documents потребляют context tokens.

## Взаимодействие с другими аргументами

- `--embedding`: включается автоматически.
- `--pooling`: `--rerank` принудительно ставит `rank`; если позже в argv указан другой `--pooling`, порядок аргументов может изменить итог.
- `--batch-size`, `--ubatch-size`, `--parallel`: важны для throughput при большом числе документов.

## INI-пресеты и router-режим

В INI пишите `rerank = true` или `reranking = true`. Для router mode лучше выделять reranker отдельным alias, чтобы chat/embedding клиенты не попадали на rank-only модель.

## Типовые проблемы и диагностика

- Route возвращает `This server does not support reranking`: нет `--rerank` или итоговый pooling не `rank`.
- Warnings при старте про BOS/EOS/SEP/rerank prompt: tokenizer/model несовместимы с reranking path.
- Ошибка `"documents" must be a non-empty string array`: body не соответствует Jina/TEI формату.
- Высокая latency: уменьшите `top_n`/число documents или настройте batching/parallelism.

## Примеры

```bash
llama-server --model /models/bge-reranker.gguf --rerank
```

```bash
llama-server --model /models/bge-reranker.gguf --embedding --pooling rank
```

## Источники

- `llama.cpp/common/arg.cpp`: `--rerank`, `--reranking`.
- `llama.cpp/common/common.cpp`: rank pooling startup checks.
- `llama.cpp/tools/server/server-context.cpp`: `/reranking` route.
- `llama.cpp/tools/server/README.md`: reranking endpoint.
