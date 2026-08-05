---
schema: 1
primaryName: "--embd-normalize"
title: "--embd-normalize"
summary: "Задает нормализацию pooled embeddings: `-1` без нормализации, `0` max-absolute/int16 scale, `1` L1, `2` L2, `>2` p-norm. Request body может переопределить значение."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--embd-normalize"
allowedValues: []
env: []
related:
  - "--embedding"
  - "--pooling"
  - "--rerank"
---

# --embd-normalize

## Кратко

`--embd-normalize` записывает `common_params::embd_normalize`. В server это default для embedding tasks; request body `/embedding` или `/v1/embeddings` может передать `embd_normalize` и переопределить CLI value.

Нормализация применяется только для pooled embeddings. При `--pooling none` server логирует, что `embd_normalize` не поддерживается, и возвращает token embeddings без этой нормализации.

## Оригинальная справка llama.cpp

```text
normalisation for embeddings (default: 2) (-1=none, 0=max absolute int16, 1=taxicab, 2=euclidean, >2=p-norm)
```

## Паспорт аргумента

- Основное имя: `--embd-normalize`
- Значение: integer `N`
- Поле `common_params`: `embd_normalize`
- По умолчанию: `2`
- Env: не задан
- Этап применения: post-processing embedding result

## Что меняет в llama-server

После вычисления embedding server получает vector через `llama_get_embeddings_seq()` для pooled modes и вызывает `common_embd_normalize(embd, embd_res.data(), n_embd_out, embd_normalize)`. Для `pooling none` берутся token embeddings через `llama_get_embeddings_ith()` и нормализация не вызывается.

## Значения и формат

- `-1`: без нормализации.
- `0`: деление на max absolute value с масштабом int16 range (`32760.0`).
- `1`: taxicab/L1 norm.
- `2`: Euclidean/L2 norm, default.
- `>2`: p-norm с `p = N`.

Код не запрещает значения меньше `-1`, но они попадут в default branch p-norm с отрицательной степенью, что практически не является полезным режимом. Для конфигурации используйте только значения из help.

## Когда использовать

- `2`: стандартный выбор для cosine similarity workflows.
- `-1`: если downstream index или модельная рекомендация требуют raw vectors.
- `0` или `1`: только если ваш retrieval pipeline явно ожидает такую нормализацию.

## Влияние на производительность и память

Нормализация проходит по vector dimension и стоит мало по сравнению с model eval. На VRAM/KV-cache не влияет. Может существенно изменить similarity scores и совместимость с уже построенным vector index; не смешивайте разные normalization режимы в одном индексе.

## Взаимодействие с другими аргументами

- `--embedding`: без embedding mode endpoints недоступны.
- `--pooling`: при `none` нормализация не применяется.
- `--rerank`: rerank использует rank pooling/scores; `--embd-normalize` не является основным quality knob для reranking.

## INI-пресеты и router-режим

В INI пишите `embd-normalize = 2` или другое число. В router mode держите значение стабильным для alias, который обслуживает один vector index.

## Типовые проблемы и диагностика

- Векторы отличаются после перезапуска: проверьте, не поменялся default `--embd-normalize` или request override.
- Debug log `embd_normalize is not supported by pooling type ...`: используется `--pooling none`.
- Retrieval качество резко изменилось: переиндексируйте documents тем же normalization режимом.

## Примеры

```bash
llama-server --model /models/embed.gguf --embedding --pooling mean --embd-normalize 2
```

```bash
llama-server --model /models/embed.gguf --embedding --pooling mean --embd-normalize -1
```

## Источники

- `llama.cpp/common/arg.cpp`: `--embd-normalize`.
- `llama.cpp/common/common.cpp`: `common_embd_normalize()`.
- `llama.cpp/tools/server/server-context.cpp`: request override и pooling check.
- `llama.cpp/tools/server/README.md`: endpoint `/embedding` option `embd_normalize`.
