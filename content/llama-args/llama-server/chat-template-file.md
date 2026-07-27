---
schema: 1
primaryName: "--chat-template-file"
title: "--chat-template-file"
summary: "Читает chat template из файла и передает его как override вместо metadata модели. Подходит для длинных или многострочных Jinja templates, которые неудобно хранить прямо в argv."
category: "Параметры llama-server"
valueType: "path"
valueHint: "JINJA_TEMPLATE_FILE"
aliases:
  - "--chat-template-file"
allowedValues: []
env:
  - "LLAMA_ARG_CHAT_TEMPLATE_FILE"
related:
  - "--chat-template"
  - "--jinja"
  - "--chat-template-kwargs"
  - "--reasoning"
  - "--skip-chat-parsing"
---

# --chat-template-file

## Кратко

`--chat-template-file` открывает файл на этапе парсинга CLI, читает его целиком через `read_file(value)` и записывает содержимое в `common_params::chat_template`. Дальше сервер работает так же, как с `--chat-template`.

Файл должен быть доступен пользователю, от имени которого запускается `llama-server`. Ошибка чтения происходит до загрузки модели.

## Оригинальная справка llama.cpp

```text
set custom jinja chat template file (default: template taken from model's metadata) if suffix/prefix are specified, template will be disabled only commonly used templates are accepted (unless --jinja is set before this flag): list of built-in templates: bailing, bailing-think, bailing2, chatglm3, chatglm4, chatml, command-r, deepseek, deepseek-ocr, deepseek2, deepseek3, exaone-moe, exaone3, exaone4, falcon3, gemma, gigachat, glmedge, gpt-oss, granite, granite-4.0, granite-4.1, grok-2, hunyuan-dense, hunyuan-moe, hunyuan-vl, kimi-k2, llama2, llama2-sys, llama2-sys-bos, llama2-sys-strip, llama3, llama4, megrez, minicpm, mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7, mistral-v7-tekken, monarch, openchat, orion, pangu-embedded, phi3, phi4, rwkv-world, seed_oss, smolvlm, solar-open, vicuna, vicuna-orca, yandex, zephyr
```

## Паспорт аргумента

- Основное имя: `--chat-template-file`
- Значение: путь к файлу `JINJA_TEMPLATE_FILE`
- Поле `common_params`: `chat_template`, после чтения файла
- Переменная окружения: `LLAMA_ARG_CHAT_TEMPLATE_FILE`
- По умолчанию: template из metadata модели
- Этап применения: парсинг CLI до инициализации модели

## Что меняет в llama-server

Аргумент не хранит путь в runtime-конфигурации; он подставляет содержимое файла в то же поле, что и `--chat-template`. Поэтому при диагностике в `/props` вы увидите сам template, а не имя файла.

После чтения содержимое проверяется общей проверкой chat template. При включенном `--jinja` это Jinja template. При отключенном Jinja допустимы только встроенные legacy templates.

## Значения и формат

Указывайте обычный путь к текстовому файлу с Jinja template. Для управляемого сервера предпочтителен абсолютный путь, чтобы не зависеть от working directory subprocess.

Файл читается полностью. Если в нем есть trailing newline, она становится частью template. Обычно это не проблема для Jinja, но при ручных минимальных templates стоит проверить фактический `example_format` в логе.

## Когда использовать

- Template занимает много строк.
- Нужно версионировать template отдельно от конфигурации arriero.
- Один и тот же template используется несколькими моделями или router preset секциями.

## Влияние на производительность и память

Чтение файла происходит один раз на старте и не влияет на inference. Runtime-эффекты такие же, как у `--chat-template`: другой template меняет длину prompt, parser ответа, stop sequences, tool call grammar и thinking-разметку.

## Взаимодействие с другими аргументами

- `--chat-template`: пишет то же поле; порядок аргументов определяет итоговое значение.
- `--jinja`: должен быть включен для произвольного Jinja.
- `--chat-template-kwargs`: передает дополнительные переменные в template context.
- `--reasoning`, `--reasoning-format`, `--skip-chat-parsing`: зависят от capabilities выбранного template.

## INI-пресеты и router-режим

В INI используйте `chat-template-file = /srv/llama/templates/model.jinja`. В router mode путь должен быть доступен из окружения router subprocess. Если models запускаются в контейнере, проверяйте путь внутри контейнера, а не на host.

## Типовые проблемы и диагностика

- `failed to open file`: путь неверен или нет прав на чтение.
- `chat template parsing error`: файл прочитан, но содержимое невалидно для выбранного `--jinja` режима.
- Несовпадает поведение после правки файла: `llama-server` не перечитывает template на лету, нужен перезапуск модели/subprocess.
- Для проверки смотрите стартовый лог `chat template, example_format: ...` и `/props`.

## Примеры

```bash
llama-server --model /models/model.gguf --chat-template-file /srv/llama/templates/chatml.jinja
```

```bash
llama-server --model /models/model.gguf --jinja --chat-template-file /srv/llama/templates/gpt-oss.jinja
```

## Источники

- `llama.cpp/common/arg.cpp`: обработчик `--chat-template-file`, `read_file(value)`.
- `llama.cpp/common/chat.cpp`: применение Jinja template и parser generation.
- `llama.cpp/tools/server/server-context.cpp`: логирование `example_format` и `/props`.
- `llama.cpp/tools/server/README.md`: описание server аргумента.
