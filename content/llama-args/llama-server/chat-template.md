---
schema: 1
primaryName: "--chat-template"
title: "--chat-template"
summary: "Задает chat template вручную и тем самым переопределяет шаблон из metadata GGUF. В Jinja-режиме это полноценный Jinja template, без `--jinja` принимаются только известные встроенные имена шаблонов."
category: "Параметры llama-server"
valueType: "string"
valueHint: "JINJA_TEMPLATE"
aliases:
  - "--chat-template"
allowedValues: []
env:
  - "LLAMA_ARG_CHAT_TEMPLATE"
related:
  - "--chat-template-file"
  - "--jinja"
  - "--chat-template-kwargs"
  - "--reasoning"
  - "--skip-chat-parsing"
---

# --chat-template

## Кратко

`--chat-template` записывает строку в `common_params::chat_template`. При старте `llama-server` эта строка передается в `common_chat_templates_init()` и заменяет шаблон, который обычно читается из metadata модели.

Используйте аргумент только когда metadata модели отсутствует, устарела или нужно принудительно выбрать совместимый формат чата. Неверный шаблон ломает не только prompt formatting, но и парсинг reasoning/tool calls в ответе.

## Оригинальная справка llama.cpp

```text
set custom jinja chat template (default: template taken from model's metadata) if suffix/prefix are specified, template will be disabled only commonly used templates are accepted (unless --jinja is set before this flag): list of built-in templates: bailing, bailing-think, bailing2, chatglm3, chatglm4, chatml, command-r, deepseek, deepseek-ocr, deepseek2, deepseek3, exaone-moe, exaone3, exaone4, falcon3, gemma, gigachat, glmedge, gpt-oss, granite, granite-4.0, granite-4.1, grok-2, hunyuan-dense, hunyuan-moe, hunyuan-vl, kimi-k2, llama2, llama2-sys, llama2-sys-bos, llama2-sys-strip, llama3, llama4, megrez, minicpm, mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7, mistral-v7-tekken, monarch, openchat, orion, pangu-embedded, phi3, phi4, rwkv-world, seed_oss, smolvlm, solar-open, vicuna, vicuna-orca, yandex, zephyr
```

## Паспорт аргумента

- Основное имя: `--chat-template`
- Значение: строка `JINJA_TEMPLATE`
- Поле `common_params`: `chat_template`
- Переменная окружения: `LLAMA_ARG_CHAT_TEMPLATE`
- По умолчанию: template берется из metadata модели
- Этап применения: парсинг CLI, затем инициализация server model context

## Что меняет в llama-server

После загрузки модели сервер вызывает `common_chat_templates_init(model_tgt, params_base.chat_template)`. Если строка непустая, она становится explicit override. Затем сервер логирует пример форматирования строкой `chat template, example_format: ...` и сохраняет template capabilities в `/props`.

При `--jinja` включен Jinja parser и строка трактуется как Jinja template. Если `--no-jinja` задан до `--chat-template`, `common_chat_verify_template()` допускает только известные built-in template names, потому что legacy path не умеет произвольный Jinja.

## Значения и формат

Значение может быть:

- полным Jinja template текстом;
- именем встроенного шаблона из списка `--help`, например `chatml`, `llama3`, `gemma`, `gpt-oss`;
- строкой, переданной через `LLAMA_ARG_CHAT_TEMPLATE`.

Для многострочного template в arriero безопаснее хранить значение отдельным argv-элементом, а не shell-строкой. Для длинных шаблонов обычно проще использовать `--chat-template-file`.

## Когда использовать

- GGUF не содержит корректный `tokenizer.chat_template`.
- Нужно временно проверить другой template без перепаковки модели.
- Модель использует известный формат, но metadata повреждена или была сконвертирована старым конвертером.

Не используйте `--chat-template` как способ исправлять sampling или stop tokens: это меняет структуру prompt и может сломать совместимость с tools, vision/audio content parts и thinking.

## Влияние на производительность и память

На KV-cache, VRAM и веса модели аргумент не влияет. Затраты появляются на этапе форматирования chat-запроса и генерации parser для ответа; обычно это мало по сравнению с inference. Косвенное влияние может быть большим: другой template добавляет или убирает служебные токены, меняет длину prompt, stop sequences и grammar для tool calls.

## Взаимодействие с другими аргументами

- `--chat-template-file`: альтернативный способ заполнить то же поле `chat_template`; выигрывает тот аргумент, который применен позже в argv.
- `--jinja` / `--no-jinja`: определяет, разрешен ли произвольный Jinja.
- `--chat-template-kwargs`: добавляет переменные в Jinja context.
- `--reasoning` и `--reasoning-format`: зависят от того, поддерживает ли выбранный template thinking-разметку.
- `--skip-chat-parsing`: оставляет formatting, но принудительно использует content-only parser для ответа.
- `--in-prefix`, `--in-suffix`, `--in-prefix-bos`: в общем CLI отключают chat template для suffix/prefix сценариев.

## INI-пресеты и router-режим

В `--models-preset` указывайте как `chat-template = ...`. Для router-сервера это per-model настройка: каждый загруженный subprocess получает свой argv. Для многострочного Jinja в INI практичнее `chat-template-file`, потому что кавычки и переносы в inline-значении труднее сопровождать.

## Типовые проблемы и диагностика

- `chat template parsing error`: Jinja не разобран или template несовместим; сервер советует `--no-jinja` или `--chat-template`.
- `Unable to generate parser for this template`: template отформатировал prompt, но autoparser не смог построить parser ответа. Проверьте `--skip-chat-parsing` как диагностический обход.
- Thinking/tool calls приходят как обычный `content`: template не содержит нужной разметки или включен `--skip-chat-parsing`.
- После смены template сравните `/props`: поля `chat_template`, `chat_template_caps` и, при Jinja, `chat_template_tool_use`.

## Примеры

```bash
llama-server --model /models/model.gguf --chat-template chatml
```

```bash
llama-server --model /models/model.gguf --jinja --chat-template "{{ bos_token }}{% for message in messages %}{{ message.role }}: {{ message.content }}{% endfor %}"
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--chat-template`, проверка `common_chat_verify_template()`.
- `llama.cpp/common/chat.cpp`: `common_chat_templates_init()`, Jinja/autoparser и pure content parser.
- `llama.cpp/tools/server/server-context.cpp`: инициализация chat templates и `/props`.
- `llama.cpp/tools/server/README.md`: актуальная таблица аргументов server.
