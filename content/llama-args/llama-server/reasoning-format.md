---
schema: 1
primaryName: "--reasoning-format"
title: "--reasoning-format"
summary: "Выбирает, как server распознает и возвращает thought/reasoning теги в ответе. `none` оставляет все в content, `deepseek` выносит мысли в `reasoning_content`, `deepseek-legacy` дублирует legacy `<think>` в content."
category: "Параметры llama-server"
valueType: "enum"
estimation: "normal"
valueHint: "FORMAT"
aliases:
  - "--reasoning-format"
allowedValues:
  - "none"
  - "auto"
  - "deepseek"
  - "deepseek-legacy"
env:
  - "LLAMA_ARG_THINK"
related:
  - "--reasoning"
  - "--reasoning-budget"
  - "--skip-chat-parsing"
  - "--jinja"
---

# --reasoning-format

## Кратко

`--reasoning-format` записывает `common_params::reasoning_format`. Это настройка parser/output: она определяет, извлекать ли thought tags из generated text и в каком поле возвращать reasoning.

Она не заставляет модель думать. Для этого используйте `--reasoning`.

## Оригинальная справка llama.cpp

```text
controls whether thought tags are allowed and/or extracted from the response, and in which format they're returned; one of:
- none: leaves thoughts unparsed in `message.content`
- deepseek: puts thoughts in `message.reasoning_content`
- deepseek-legacy: keeps `<think>` tags in `message.content` while also populating `message.reasoning_content`
(default: auto)
```

## Паспорт аргумента

- Основное имя: `--reasoning-format`
- Значения: `none`, `auto`, `deepseek`, `deepseek-legacy`
- Поле `common_params`: `reasoning_format`
- Переменная окружения: `LLAMA_ARG_THINK`
- Этап применения: startup default и per-request parser params

## Что меняет в llama-server

Значение попадает в `common_chat_templates_inputs::reasoning_format` при prompt formatting и в `common_chat_parser_params::reasoning_format` при разборе ответа. Клиент может переопределить его в JSON body полем `reasoning_format`.

Для streaming `deepseek-legacy` server ставит `reasoning_in_content = true`, поэтому `<think>`-совместимый content сохраняется, но `reasoning_content` также заполняется.

## Значения и формат

- `none`: не извлекать reasoning; теги остаются обычным текстом.
- `auto`: автоопределение формата по template/parser.
- `deepseek`: выносить мысли в `message.reasoning_content`.
- `deepseek-legacy`: сохранять legacy `<think>` tags в `message.content` и одновременно заполнять `reasoning_content`.

Неизвестное значение приводит к `Unknown reasoning format: <value>`.

## Когда использовать

- `auto`: default для современных templates.
- `none`: нужна сырая совместимость со старым клиентом, который ожидает весь текст в `content`.
- `deepseek`: OpenAI-compatible клиенты, где reasoning должно быть отделено от user-visible answer.
- `deepseek-legacy`: клиенты или UI, которые все еще ожидают `<think>...</think>` в content.

## Влияние на производительность и память

Влияние небольшое: parser разбирает generated text и формирует поля ответа. Косвенно формат может включить reasoning-aware parser и stop/grammar поведение из template. На модель, VRAM и KV-cache напрямую не влияет.

## Взаимодействие с другими аргументами

- `--reasoning`: управляет генерацией thinking, а не parsing.
- `--reasoning-budget`: требует start/end thinking tags, которые приходят из chat template params.
- `--skip-chat-parsing`: принудительно выключает структурное извлечение reasoning/tool calls.
- `--jinja` и `--chat-template`: определяют, есть ли у parser информация о thinking tags.

## INI-пресеты и router-режим

В INI используйте `reasoning-format = deepseek` или другое допустимое значение. В router mode формат лучше задавать per-model: разные templates используют разные thinking delimiters.

## Типовые проблемы и диагностика

- `reasoning_content` пустой: модель не сгенерировала tags, template не поддерживает thinking или включен `--skip-chat-parsing`.
- В content видны `<think>` tags при `deepseek`: проверьте, не переопределил ли клиент `reasoning_format` в body.
- Ошибка `Unknown reasoning format`: значение вне списка `none`, `auto`, `deepseek`, `deepseek-legacy`.
- Для потоковых ответов сравните поля delta: server-task отдельно отправляет reasoning deltas.

## Примеры

```bash
llama-server --model /models/reasoning.gguf --reasoning on --reasoning-format deepseek
```

```bash
llama-server --model /models/reasoning.gguf --reasoning-format none
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--reasoning-format`.
- `llama.cpp/common/chat.cpp`: `common_reasoning_format_from_name()`.
- `llama.cpp/tools/server/server-task.cpp`: parser params и streaming deltas.
- `llama.cpp/tools/server/README.md`: описание форматов.
