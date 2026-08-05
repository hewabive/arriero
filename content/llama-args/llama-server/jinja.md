---
schema: 1
primaryName: "--jinja"
title: "--jinja"
summary: "Включает или отключает Jinja engine для chat templates. По умолчанию в server Jinja включен; `--no-jinja` оставляет только legacy/built-in templates и ограничивает поддержку tools/reasoning."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--jinja"
  - "--no-jinja"
allowedValues: []
env:
  - "LLAMA_ARG_JINJA"
related:
  - "--chat-template"
  - "--chat-template-file"
  - "--chat-template-kwargs"
  - "--reasoning"
  - "--skip-chat-parsing"
---

# --jinja

## Кратко

`--jinja` управляет `common_params::use_jinja`. В `llama-server` default включен, поэтому обычный запуск использует Jinja template engine для chat formatting, tools, multimodal content parts и parser generation.

`--no-jinja` полезен как совместимость или диагностика, но с ним произвольный Jinja template не поддерживается.

## Оригинальная справка llama.cpp

```text
whether to use jinja template engine for chat (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--jinja`
- Отрицательная форма: `--no-jinja`
- Поле `common_params`: `use_jinja`
- Переменная окружения: `LLAMA_ARG_JINJA`
- По умолчанию: enabled
- Этап применения: startup, при построении chat templates и parser

## Что меняет в llama-server

При старте server строит `common_chat_templates` и затем передает `params_base.use_jinja` в `common_chat_format_example()` и runtime chat formatting. Если Jinja включен, `common_chat_templates_apply()` использует Jinja path, capabilities template, tool-use variant и autoparser.

Если Jinja выключен, server работает через legacy route для известных шаблонов. Проверка `common_chat_verify_template()` ограничивает `--chat-template` списком commonly used templates.

## Значения и формат

Аргумент boolean-pair:

- `--jinja` включает;
- `--no-jinja` отключает;
- через env используйте `LLAMA_ARG_JINJA=true` или `LLAMA_ARG_JINJA=false`.

## Когда использовать

Оставляйте `--jinja` включенным для современных instruct/chat моделей, особенно если нужны tool calls, reasoning parsing, `chat_template_kwargs`, vision/audio chat parts или templates из metadata.

Используйте `--no-jinja`, когда текущий Jinja parser не принимает template модели, а вы готовы явно выбрать legacy template, например `--no-jinja --chat-template chatml`.

## Влияние на производительность и память

Jinja добавляет небольшую CPU-работу при подготовке запроса и генерации parser. На RAM/VRAM модели, KV-cache и batch sizes напрямую не влияет. Основной риск производительности косвенный: другой template может заметно изменить число prompt tokens.

## Взаимодействие с другими аргументами

- `--chat-template` и `--chat-template-file`: произвольные Jinja templates требуют включенного `--jinja`.
- `--chat-template-kwargs`: имеет смысл только когда template читает extra context.
- `--reasoning`: auto-detect thinking работает только если Jinja включен и template supports thinking.
- `--skip-chat-parsing`: может использоваться вместе с Jinja, чтобы оставить template rendering, но отключить структурный parser ответа.

## INI-пресеты и router-режим

В INI положительная форма обычно пишется `jinja = true`, отрицательная `no-jinja = true`. Для router mode настройка должна быть задана в секции конкретной модели, если разные модели требуют разные template engines.

## Типовые проблемы и диагностика

- `chat template parsing error`: попробуйте обновить template или временно запустить `--no-jinja --chat-template <built-in>`.
- `template supports tool calls but does not natively describe tools`: template распознан, но tool schema будет fallback; проверьте `--verbose` и prompt.
- `chat template, thinking = 0`: Jinja выключен или template не поддерживает thinking.
- Смотрите `/props`: `chat_template_caps` показывает обнаруженные возможности.

## Примеры

```bash
llama-server --model /models/model.gguf --jinja
```

```bash
llama-server --model /models/model.gguf --no-jinja --chat-template chatml
```

## Источники

- `llama.cpp/common/arg.cpp`: `--jinja`, `--no-jinja`.
- `llama.cpp/common/chat.cpp`: Jinja path, legacy route, template capabilities.
- `llama.cpp/tools/server/server-context.cpp`: startup инициализация chat templates.
- `llama.cpp/tools/server/README.md`: справка server.
