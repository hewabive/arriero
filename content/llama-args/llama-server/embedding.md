---
schema: 1
primaryName: "--embedding"
title: "--embedding"
summary: "Переводит server в embedding-capable context и открывает embedding endpoints. Используйте с dedicated embedding models; для rerank удобнее `--rerank`, который также ставит `--pooling rank`."
category: "Параметры llama-server"
valueType: "flag"
valueHint: null
aliases:
  - "--embedding"
  - "--embeddings"
allowedValues: []
env:
  - "LLAMA_ARG_EMBEDDINGS"
related:
  - "--pooling"
  - "--embd-normalize"
  - "--rerank"
  - "--batch-size"
  - "--ubatch-size"
---

# --embedding

## Кратко

`--embedding` ставит `common_params::embedding = true`. При создании context это передается как `llama_context_params::embeddings`, после чего server разрешает `/embedding` и `/v1/embeddings`.

Без этого флага embedding endpoint отвечает `This server does not support embeddings. Start it with --embeddings`.

## Оригинальная справка llama.cpp

```text
restrict to only support embedding use case; use only with dedicated embedding models (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--embedding`
- Алиас: `--embeddings`
- Тип: флаг без значения
- Поле `common_params`: `embedding`
- Переменная окружения: `LLAMA_ARG_EMBEDDINGS`
- По умолчанию: disabled
- Этап применения: создание llama context и HTTP route checks

## Что меняет в llama-server

Server создает context с embeddings enabled. Route `/embedding` и OpenAI-compatible `/v1/embeddings` начинают принимать requests. Внутри task type становится `SERVER_TASK_TYPE_EMBEDDING`, а результат формируется из `llama_get_embeddings_ith()` или `llama_get_embeddings_seq()` в зависимости от pooling.

Фраза help "restrict to only support embedding use case" означает, что режим предназначен для embedding models. Не рассчитывайте на полноценный chat/completions workflow с embedding-only моделью.

## Значения и формат

Флаг без значения:

```bash
llama-server --model /models/embed.gguf --embedding
```

Отрицательной формы в `arg.cpp` нет.

## Когда использовать

- Dedicated embedding models.
- Multimodal embeddings, если модель и mtmd context это поддерживают.
- Retrieval pipeline, где server должен отдавать vectors через `/embedding` или `/v1/embeddings`.

Для reranker models используйте `--rerank`, потому что он включает `--embedding` и правильный rank pooling.

## Влияние на производительность и память

Embedding requests обычно нагружают prompt processing/prefill, а не autoregressive decode. Throughput зависит от `--batch-size`, `--ubatch-size`, `--parallel`, CPU/GPU backend и pooling. До создания context server проверяет `n_batch > n_ubatch` и принудительно делает `n_batch = n_ubatch`, чтобы все токены embedding-запроса помещались в один ubatch. Поэтому фактический batch и его compute reservation могут быть меньше прямо заданного `--batch-size`; Arriero повторяет это преобразование.

## Взаимодействие с другими аргументами

- `--pooling`: определяет форму embedding result; для `/v1/embeddings` pooling `none` не совместим.
- `--embd-normalize`: нормализует pooled embeddings.
- `--rerank`: включает embedding и ставит `pooling_type = rank`.
- `--batch-size`, `--ubatch-size`, `--parallel`, `--ctx-size`: основные knobs throughput/памяти.

## INI-пресеты и router-режим

В INI пишите `embedding = true`. В router mode embedding model лучше выделять отдельным alias/tag и не смешивать с chat aliases, потому что клиенты выбирают модель через JSON field `model`.

## Типовые проблемы и диагностика

- `/embedding` возвращает `This server does not support embeddings`: флаг не попал в argv или model subprocess запущен без него.
- `/v1/embeddings` ругается на pooling `none`: задайте pooled strategy.
- Плохое качество vectors: проверьте, что модель действительно embedding, а не chat/instruct.
- Низкий throughput: смотрите batch/ubatch и число parallel slots.

## Примеры

```bash
llama-server --model /models/embed.gguf --embedding --pooling mean --embd-normalize 2
```

```bash
llama-server --model /models/embed.gguf --embedding --batch-size 2048 --ubatch-size 2048
```

## Источники

- `llama.cpp/common/arg.cpp`: `--embedding`, `--embeddings`.
- `llama.cpp/common/common.cpp`: `cparams.embeddings`.
- `llama.cpp/tools/server/server-context.cpp`: embedding routes and result extraction.
- `llama.cpp/tools/server/README.md`: `/embedding`, `/v1/embeddings`.
