---
schema: 1
primaryName: "--alias"
title: "--alias"
summary: "Задает одно или несколько API-имен модели. В router-режиме алиасы используются для поиска модели и должны быть уникальны."
category: "Параметры llama-server"
valueType: "list"
estimation: "normal"
valueHint: "STRING"
aliases:
  - "-a"
  - "--alias"
allowedValues: []
env:
  - "LLAMA_ARG_ALIAS"
related:
  - "--model"
  - "--hf-repo"
  - "--models-dir"
  - "--models-preset"
  - "--tags"
---

# --alias

## Кратко

`--alias` добавляет модели одно или несколько имен, которые видны в API. Значение разбирается как comma-separated список; пробелы вокруг элементов удаляются, пустые элементы игнорируются.

В одиночном server mode первый alias из внутреннего `std::set` становится `id` модели в `/models` и `/v1/models`. В router-режиме алиасы дополнительно работают как имена маршрутизации: запрос с `"model": "alias"` попадет в соответствующую модель.

## Оригинальная справка llama.cpp

```text
set model name aliases, comma-separated (to be used by API)
```

## Паспорт аргумента

- Основное имя: `--alias`
- Алиасы CLI: `-a`, `--alias`
- Тип: `STRING`, comma-separated list
- Переменная окружения: `LLAMA_ARG_ALIAS`
- Поле `common_params`: `model_alias`
- Внутренний тип: `std::set<std::string>`
- Этап применения: парсинг CLI/env, затем публикация metadata и router lookup

## Что меняет в llama-server

Парсер делит значение по запятым, применяет `string_strip()` к каждому элементу и добавляет непустые строки в `params.model_alias`.

В single-model mode:

- `server_context` сохраняет все aliases в `model_aliases`;
- если aliases не пусты, `model_name` берется из первого элемента `std::set`, то есть фактически в лексикографическом порядке;
- `/models` и `/v1/models` возвращают `id` из `model_name` и массив `aliases`.

В router mode:

- aliases читаются из модельного preset до запуска дочернего процесса;
- router проверяет конфликты alias с именами моделей и aliases других моделей;
- `get_meta()` ищет модель по canonical name или alias;
- дочернему `llama-server` router перезаписывает `--alias` canonical name модели.

## Значения и формат

```bash
llama-server --model /srv/models/qwen.gguf --alias qwen-coder
```

```bash
llama-server --model /srv/models/qwen.gguf --alias qwen-coder,coder,code
```

Регистр не нормализуется: `Coder` и `coder` являются разными строками. Запятые внутри alias не поддерживаются, потому что запятая является разделителем списка.

## Когда использовать

Используйте `--alias`, чтобы клиенты не зависели от пути к GGUF, HF repo или имени секции INI. Это особенно полезно для OpenAI-compatible клиентов, где поле `model` часто ожидает короткое стабильное имя.

В router mode задавайте alias в `--models-preset`, а не в глобальном CLI, если разные модели должны иметь разные имена.

## Влияние на производительность и память

На inference, RAM, VRAM, KV-cache и batch параметры не влияет. В router mode alias влияет только на lookup и на содержимое `/models`.

Косвенный эффект возможен при конфликте имен: router может отказаться стартовать или пропустить конфликтующий alias при reload, из-за чего клиентский запрос по старому имени перестанет находить модель.

## Взаимодействие с другими аргументами

`--tags` похож по формату, но tags не участвуют в маршрутизации.

`--models-preset` является основным местом для alias в router:

```ini
[qwen2.5-coder-7b-q8_0]
model = /srv/models/qwen2.5-coder-7b-q8_0.gguf
alias = coder,qwen-coder
tags = code,local
```

Если `--alias` задан глобально в CLI router-процесса, он попадает в base preset и может быть слит со всеми модельными пресетами до того, как router перезапишет alias дочернему процессу. Для multi-model конфигурации это обычно нежелательно.

## INI-пресеты и router-режим

В INI ключ пишется как `alias = ...` или `LLAMA_ARG_ALIAS = ...`.

При первой загрузке router останавливается на конфликте alias с существующим именем модели или alias другой модели. При reload конфликтующий alias логируется предупреждением `(reload) alias ... conflicts ... skipping` и не добавляется.

## Типовые проблемы и диагностика

- `/models` показывает неожиданный `id`: при нескольких aliases single-model server берет первый элемент отсортированного `std::set`, а не первый элемент исходной строки.
- Router отвечает `model 'x' not found`: проверьте, что alias есть в JSON `/models` и не был пропущен из-за конфликта.
- Старт router падает на конфликте: alias совпал с именем другой модели или чужим alias.
- Клиенты используют путь к модели вместо alias: задайте короткое имя и используйте его в JSON поле `model`.

## Примеры

```bash
llama-server --model /srv/models/qwen.gguf --alias coder
```

```bash
llama-server --models-preset /srv/llama/models.ini
```

```bash
curl -s http://127.0.0.1:8080/models
```

## Источники

- `llama.cpp/common/arg.cpp`: парсинг `--alias`.
- `llama.cpp/common/common.h`: `model_alias`.
- `llama.cpp/tools/server/server-context.cpp`: выбор `model_name`, поля `/models`.
- `llama.cpp/tools/server/server-models.cpp`: router aliases, conflict validation, lookup.
- `llama.cpp/tools/server/tests/unit/test_basic.py`: проверка aliases/tags и порядка `id`.
