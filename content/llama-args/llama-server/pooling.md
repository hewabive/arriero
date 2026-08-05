---
schema: 1
primaryName: "--pooling"
title: "--pooling"
summary: "Выбирает pooling strategy для embedding context: `none`, `mean`, `cls`, `last` или `rank`. Для OpenAI-compatible embeddings нужен pooled режим, для rerank используется `rank`."
category: "Параметры llama-server"
valueType: "enum"
estimation: "normal"
valueHint: "{none,mean,cls,last,rank}"
aliases:
  - "--pooling"
allowedValues:
  - "none"
  - "mean"
  - "cls"
  - "last"
  - "rank"
env:
  - "LLAMA_ARG_POOLING"
related:
  - "--embedding"
  - "--rerank"
  - "--embd-normalize"
---

# --pooling

## Кратко

`--pooling` записывает `common_params::pooling_type` и передается в `llama_context_params::pooling_type` при создании context. Значение определяет, как token-level embeddings превращаются в один vector на sequence.

Если не указано, используется model default (`LLAMA_POOLING_TYPE_UNSPECIFIED`).

## Оригинальная справка llama.cpp

```text
pooling type for embeddings, use model default if unspecified
```

## Паспорт аргумента

- Основное имя: `--pooling`
- Значения: `none`, `mean`, `cls`, `last`, `rank`
- Поле `common_params`: `pooling_type`
- Переменная окружения: `LLAMA_ARG_POOLING`
- Этап применения: создание llama context

## Что меняет в llama-server

Для `/embedding` и `/v1/embeddings` server смотрит фактический `llama_pooling_type(ctx)`. Если pooling `none`, server возвращает token embeddings, но OpenAI-compatible endpoint отклоняет такой режим сообщением `Pooling type 'none' is not OAI compatible. Please use a different pooling type`.

Для `/reranking` требуется `params.embedding = true` и `params.pooling_type == LLAMA_POOLING_TYPE_RANK`. Флаг `--rerank` выставляет оба значения автоматически.

## Значения и формат

- `none`: не объединять, вернуть embeddings по token positions.
- `mean`: среднее по sequence.
- `cls`: CLS pooling.
- `last`: last-token pooling.
- `rank`: ranking score/pooling для reranker models.

Неизвестное значение приводит к `invalid value`.

## Когда использовать

- `mean`, `cls`, `last`: embedding models, в зависимости от training/config модели.
- `none`: диагностика token embeddings или non-OAI `/embedding`.
- `rank`: reranker models и endpoint `/reranking`.

Для большинства dedicated embedding GGUF лучше начать с model default и менять только при явной рекомендации модели.

## Влияние на производительность и память

Pooling type влияет на форму результата и небольшой объем post-processing. `none` может вернуть много vectors на один input, что увеличит response size и память на ответ. `rank` меняет сценарий на reranking, где каждый документ становится отдельной задачей.

## Взаимодействие с другими аргументами

- `--embedding`: включает embedding context; без него endpoints embedding/rerank недоступны.
- `--rerank`: shortcut для `--embedding --pooling rank`.
- `--embd-normalize`: применяется только когда pooling не `none`.
- `--batch-size` и `--ubatch-size`: важны для throughput embedding requests.

## INI-пресеты и router-режим

В INI пишите `pooling = mean` или другое значение. В router mode задавайте per-model, потому что pooling должен соответствовать архитектуре и training objective модели.

## Типовые проблемы и диагностика

- `/v1/embeddings` возвращает ошибку про `Pooling type 'none'`: задайте `--pooling mean`, `cls` или `last`.
- `/reranking` возвращает `This server does not support reranking`: нужен `--rerank` или `--embedding --pooling rank`.
- Reranking warning при старте про BOS/EOS/SEP/rerank prompt: модель/tokenizer не подходит для rank pooling.

## Примеры

```bash
llama-server --model /models/embed.gguf --embedding --pooling mean
```

```bash
llama-server --model /models/reranker.gguf --embedding --pooling rank
```

## Источники

- `llama.cpp/common/arg.cpp`: parsing `--pooling`.
- `llama.cpp/common/common.cpp`: передача `pooling_type` в context и rerank warnings.
- `llama.cpp/tools/server/server-context.cpp`: embedding/rerank route checks.
- `llama.cpp/tools/server/README.md`: embedding и reranking endpoints.
