---
schema: 1
primaryName: "--skip-chat-parsing"
title: "--skip-chat-parsing"
summary: "Принудительно использует pure content parser для chat responses. Formatting template остается, но reasoning и tool calls не извлекаются в отдельные поля."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--skip-chat-parsing"
  - "--no-skip-chat-parsing"
allowedValues: []
env:
  - "LLAMA_ARG_SKIP_CHAT_PARSING"
related:
  - "--chat-template"
  - "--jinja"
  - "--reasoning-format"
  - "--tools"
---

# --skip-chat-parsing

## Кратко

`--skip-chat-parsing` записывает `common_params::force_pure_content_parser = true`. В Jinja path template все еще применяется к входным messages, но parser ответа строится как `content(rest())`: все generated text возвращается как обычный content.

Используйте как диагностический или compatibility режим, когда autoparser/tool parser ломает ответы модели.

## Оригинальная справка llama.cpp

```text
force a pure content parser, even if a Jinja template is specified; model will output everything in the content section, including any reasoning and/or tool calls (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--skip-chat-parsing`
- Отрицательная форма: `--no-skip-chat-parsing`
- Поле `common_params`: `force_pure_content_parser`
- Переменная окружения: `LLAMA_ARG_SKIP_CHAT_PARSING`
- По умолчанию: disabled

## Что меняет в llama-server

В `common_chat_templates_apply_jinja()` при `inputs.force_pure_content` server логирует warning `Forcing pure content template, will not render reasoning or tools separately.` Затем он строит prompt обычным template rendering, но возвращает `COMMON_CHAT_FORMAT_PEG_NATIVE` parser, который берет весь остаток после generation prompt как content.

Это не отключает chat template и не отключает generation prompt. Оно отключает структурное извлечение reasoning/tool calls из ответа.

## Значения и формат

Boolean-pair:

- `--skip-chat-parsing`: включить pure content parser;
- `--no-skip-chat-parsing`: выключить и вернуться к parser по template.

## Когда использовать

- Template корректно форматирует prompt, но automatic parser падает.
- Модель генерирует нестандартный tool call формат, который лучше обработать на стороне клиента.
- Нужно временно вернуть старое поведение, где весь ответ находится в `content`.

Не используйте для production tool calling, если клиент ожидает structured `tool_calls`.

## Влияние на производительность и память

Может немного снизить CPU post-processing, потому что parser проще. На inference, KV-cache и память модели не влияет. Косвенно может увеличить клиентскую нагрузку: parsing reasoning/tool calls придется делать снаружи.

## Взаимодействие с другими аргументами

- `--reasoning-format`: фактически нейтрализуется для структурного вывода; reasoning останется в content.
- `--tools`: tool schemas могут быть включены в prompt, но tool calls не будут вынесены в отдельные поля.
- `--chat-template` и `--jinja`: formatting сохраняется.
- `--reasoning-budget`: budget sampler может продолжать работать, если template дал thinking tags.

## INI-пресеты и router-режим

В INI используйте `skip-chat-parsing = true` или отрицательную форму `no-skip-chat-parsing = true`. Для router mode задавайте только тем моделям, чей template/parser проблемен.

## Типовые проблемы и диагностика

- Клиент перестал получать `tool_calls`: это ожидаемо при включенном `--skip-chat-parsing`.
- `reasoning_content` пустой, а `<think>` виден в `content`: pure content parser включен.
- В логе есть warning `Forcing pure content template`: режим активен.

## Примеры

```bash
llama-server --model /models/model.gguf --skip-chat-parsing
```

```bash
llama-server --model /models/model.gguf --no-skip-chat-parsing
```

## Источники

- `llama.cpp/common/arg.cpp`: `force_pure_content_parser`.
- `llama.cpp/common/chat.cpp`: branch `inputs.force_pure_content`.
- `llama.cpp/tools/server/server-context.cpp`: передача в `chat_params`.
- `llama.cpp/tools/server/README.md`: описание аргумента.
