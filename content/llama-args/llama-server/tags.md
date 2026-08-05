---
schema: 1
primaryName: "--tags"
title: "--tags"
summary: "Добавляет информационные теги модели в metadata API. Теги выводятся в `/models`, но не участвуют в выборе маршрута."
category: "Параметры llama-server"
valueType: "list"
estimation: "normal"
valueHint: "STRING"
aliases:
  - "--tags"
allowedValues: []
env:
  - "LLAMA_ARG_TAGS"
related:
  - "--alias"
  - "--models-preset"
  - "--models-dir"
---

# --tags

## Кратко

`--tags` задает comma-separated список информационных тегов модели. Они попадают в metadata API, но не используются для маршрутизации запросов и не заменяют `--alias`.

## Оригинальная справка llama.cpp

```text
set model tags, comma-separated (informational, not used for routing)
```

## Паспорт аргумента

- Основное имя: `--tags`
- Алиасы: `--tags`
- Тип: `STRING`, comma-separated list
- Переменная окружения: `LLAMA_ARG_TAGS`
- Поле `common_params`: `model_tags`
- Внутренний тип: `std::set<std::string>`
- Этап применения: парсинг CLI/env, затем публикация metadata

## Что меняет в llama-server

Парсер делит строку по запятым, удаляет пробелы вокруг каждого тега и добавляет непустые строки в `params.model_tags`.

В single-model mode tags сохраняются в `server_context` и возвращаются в `/models` и `/v1/models`.

В router mode tags читаются из модельного preset, сохраняются в `server_model_meta.tags` и возвращаются в списке `/models`. Router не ищет модель по tag и не фильтрует по tags.

## Значения и формат

```bash
llama-server --model /srv/models/qwen.gguf --tags code,local,q8_0
```

Повторяющиеся теги схлопываются из-за `std::set`. Регистр не нормализуется: `Vision` и `vision` будут разными тегами.

## Когда использовать

Используйте `--tags`, чтобы UI, inventory-скрипты или администратор могли отличать модели по назначению: `chat`, `code`, `embedding`, `vision`, `local`, `hf`, `experimental`.

Не используйте tags как механизм access control или routing. Клиент должен указывать canonical model id или alias.

## Влияние на производительность и память

На inference, загрузку весов, KV-cache, RAM и VRAM не влияет. Это metadata.

Большой список тегов увеличивает только JSON metadata и шум в логах `Available models`.

## Взаимодействие с другими аргументами

`--alias` участвует в API-имени и router lookup; `--tags` только описывает модель.

В `--models-preset` tags удобно задавать рядом с alias:

```ini
[embeddinggemma]
embd-gemma-default = true
alias = embeddings
tags = embedding,gemma,default
```

При reload router перечитывает tags для unloaded моделей. Для running модели с измененным preset router сначала выгружает ее как измененную, затем обновляет metadata.

## INI-пресеты и router-режим

В INI ключ пишется как `tags = ...` или `LLAMA_ARG_TAGS = ...`.

В ответе `/models` tags возвращаются отдельно:

```json
{
  "id": "coder",
  "aliases": ["qwen-coder"],
  "tags": ["code", "local"]
}
```

## Типовые проблемы и диагностика

- Запрос с `"model": "code"` не находит модель: `code` был tag, а не alias.
- Tags не обновились после правки INI: вызовите `GET /models?reload=1`.
- Порядок tags отличается от строки запуска: хранение идет через `std::set`, порядок сортированный.

## Примеры

```bash
llama-server --model /srv/models/gemma.gguf --tags chat,gemma,local
```

```bash
llama-server --models-preset /srv/llama/models.ini
```

```bash
curl -s http://127.0.0.1:8080/models
```

## Источники

- `llama.cpp/common/arg.cpp`: парсинг `--tags`.
- `llama.cpp/common/common.h`: `model_tags`.
- `llama.cpp/tools/server/server-context.cpp`: tags в metadata single-model server.
- `llama.cpp/tools/server/server-models.cpp`: tags в router metadata и reload.
- `llama.cpp/tools/server/README.md`: help-строка и `/models`.
