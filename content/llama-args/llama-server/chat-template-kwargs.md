---
schema: 1
primaryName: "--chat-template-kwargs"
title: "--chat-template-kwargs"
summary: "Передает дополнительные JSON-параметры в Jinja chat template context. Используйте для template-specific переменных; `enable_thinking` через этот путь deprecated в пользу `--reasoning`."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "STRING"
aliases:
  - "--chat-template-kwargs"
allowedValues: []
env:
  - "LLAMA_ARG_CHAT_TEMPLATE_KWARGS"
related:
  - "--chat-template"
  - "--chat-template-file"
  - "--jinja"
  - "--reasoning"
  - "--reasoning-effort"
---

# --chat-template-kwargs

## Кратко

`--chat-template-kwargs` принимает строку с JSON object, разбирает ее через `json::parse()` и добавляет пары в `common_params::default_template_kwargs`. Значения сохраняются как JSON dumps, а при применении template снова разбираются и попадают в `params.extra_context`.

Это не настройка sampling. Аргумент влияет только на rendering chat template.

## Оригинальная справка llama.cpp

```text
sets additional params for the json template parser, must be a valid json object string, e.g. '{"key1":"value1","key2":"value2"}'
```

## Паспорт аргумента

- Основное имя: `--chat-template-kwargs`
- Значение: JSON object в одной строке
- Поле `common_params`: `default_template_kwargs`
- Переменная окружения: `LLAMA_ARG_CHAT_TEMPLATE_KWARGS`
- Этап применения: CLI parse, затем merge с request-level `chat_template_kwargs`
- Требует Jinja template для практического эффекта

## Что меняет в llama-server

При каждом chat-запросе server сначала берет defaults из CLI, затем поверх них накладывает поле JSON body `chat_template_kwargs`, если клиент его передал. Это значит, что request-level kwargs имеют приоритет над CLI defaults.

Ключ `enable_thinking` отдельно распознается сервером. Если он равен JSON boolean `true` или `false`, он переопределяет `inputs.enable_thinking`. Если он передан строкой, сервер бросает ошибку типа `invalid type for "enable_thinking"`.

## Значения и формат

Значение обязано быть JSON object:

```json
{ "reasoning_effort": "high", "custom_flag": true }
```

Строки, числа, boolean, массивы и объекты внутри значения допустимы как JSON. Невалидный JSON завершит запуск ошибкой парсинга.

## Когда использовать

- Template ожидает нестандартную переменную. Для `reasoning_effort` есть выделенный сахар `--reasoning-effort` — оба пишут в один map, при обоих в argv выигрывает последний.
- Нужно задать default для всех клиентов, но оставить возможность переопределить его в body запроса.
- Вы поддерживаете кастомный Jinja template и хотите избежать fork исходников.

Для включения/отключения thinking используйте `--reasoning on`, `--reasoning off` или `--reasoning auto`, а не `{"enable_thinking":...}`.

## Влияние на производительность и память

Влияние ограничено JSON parsing и rendering template. На KV-cache и веса модели аргумент не влияет. Косвенно kwargs могут изменить prompt, если template по ним добавляет секции, tokens или специальные инструкции.

## Взаимодействие с другими аргументами

- `--chat-template` и `--chat-template-file`: template должен реально читать эти kwargs.
- `--jinja`: legacy non-Jinja templates не используют произвольный Jinja context.
- `--reasoning`: предпочтительный способ управлять `enable_thinking`.
- `--skip-chat-parsing`: не отменяет rendering kwargs, но меняет parser ответа.

## INI-пресеты и router-режим

В `--models-preset` значение нужно писать как JSON string, например `chat-template-kwargs = {"reasoning_effort":"high"}`. Для router mode это per-model default; клиенты все равно могут передать `chat_template_kwargs` в конкретном запросе.

## Типовые проблемы и диагностика

- Сервер не стартует: проверьте, что значение является JSON object, а не shell-подобной строкой.
- `Setting 'enable_thinking' via --chat-template-kwargs is deprecated`: замените на `--reasoning`.
- `invalid type for "enable_thinking"`: передан `"false"` как строка, нужен boolean `false`.
- Template не реагирует: проверьте, что выбранный Jinja template обращается к такому ключу.

## Примеры

```bash
llama-server --model /models/model.gguf --chat-template-kwargs '{"reasoning_effort":"high"}'
```

```bash
llama-server --model /models/model.gguf --reasoning off --chat-template-kwargs '{"custom_mode":true}'
```

## Источники

- `llama.cpp/common/arg.cpp`: JSON parsing и warning для `enable_thinking`.
- `llama.cpp/tools/server/server-common.cpp`: merge CLI kwargs с request kwargs.
- `llama.cpp/common/chat.cpp`: добавление kwargs в Jinja `extra_context`.
- `llama.cpp/tools/server/README.md`: server help table.
