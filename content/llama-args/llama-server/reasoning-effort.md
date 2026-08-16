---
schema: 1
primaryName: "--reasoning-effort"
title: "--reasoning-effort"
summary: "Задает default уровень reasoning effort, передаваемый в Jinja chat template как переменная `reasoning_effort`. Работает только с template, который реально читает эту переменную; `default` оставляет поведение template без изменений."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "LEVEL"
aliases:
  - "--reasoning-effort"
allowedValues: []
env:
  - "LLAMA_ARG_REASONING_EFFORT"
related:
  - "--reasoning"
  - "--reasoning-budget"
  - "--reasoning-format"
  - "--chat-template-kwargs"
  - "--jinja"
---

# --reasoning-effort

## Кратко

`--reasoning-effort` — это сахар над `--chat-template-kwargs '{"reasoning_effort":"..."}'`: значение записывается в `common_params::default_template_kwargs["reasoning_effort"]` и при rendering chat template становится Jinja-переменной. Специальное значение `default` удаляет ключ из map, оставляя template его собственный default.

Аргумент не ограничивает генерацию сам по себе. Он лишь сообщает template желаемый уровень усилий; template решает, какие инструкции или специальные tokens вставить в prompt.

## Оригинальная справка llama.cpp

```text
reasoning effort level given to the chat template: 'default' to keep the template default,
or a level such as 'minimal', 'low', 'medium', 'high', 'xhigh' or 'max' (default: default)
```

## Паспорт аргумента

- Основное имя: `--reasoning-effort`
- Значение: строка `LEVEL`; `default` = не передавать переменную
- Поле `common_params`: `default_template_kwargs["reasoning_effort"]`
- Переменная окружения: `LLAMA_ARG_REASONING_EFFORT`
- По умолчанию: `default` (переменная не задана, действует default template)
- Этап применения: CLI parse, затем merge с request-level параметрами при каждом chat-запросе

## Что меняет в llama-server

При применении template значение попадает в Jinja context сразу под двумя именами: `caps_apply_reasoning_effort` устанавливает и `reasoning_effort`, и `reasoning_strength` — разные семейства template используют разные имена, оба привязаны к одному значению.

Уровни из справки — `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — это примеры, а не enum: parser принимает любую строку кроме `default` без валидации. Какие уровни осмысленны, определяет конкретный template (например, GPT-OSS понимает `low`/`medium`/`high`).

llama.cpp определяет capability `supports_reasoning_effort` пробным rendering: если template нигде не читает `reasoning_effort`/`reasoning_strength`, аргумент инертен — prompt не меняется.

## Приоритет: CLI, kwargs, request body

Значение — это только default. Приоритет по возрастанию:

1. `--reasoning-effort` и `--chat-template-kwargs` пишут в один map по ключу `reasoning_effort`; при обоих в argv для этого ключа выигрывает последний.
2. Request-level `chat_template_kwargs.reasoning_effort` в JSON body перекрывает CLI defaults.
3. OpenAI-поле `reasoning_effort` в body chat completions перекрывает все выше. Особый случай: `"reasoning_effort":"none"` не передается в template, а выключает thinking целиком (`enable_thinking=false`), как `--reasoning off` для этого запроса.
4. В Responses API `reasoning.effort` конвертируется в то же поле `reasoning_effort`.

## Когда использовать

- Модель с управляемым усилием reasoning (GPT-OSS и аналоги), и нужен серверный default вместо ожидания поля от каждого клиента.
- Снизить латентность ответов, задав `low`/`minimal` для инстанса, обслуживающего быстрые интерактивные запросы.
- Поднять качество сложных задач через `high`, не трогая клиентов.

## Влияние на производительность и память

На KV-cache и веса модели не влияет (`estimation: normal`). Косвенное влияние существенное: уровень effort меняет длину thinking-секции, а значит время до первого токена ответа и расход context. Это soft-управление через prompt — в отличие от `--reasoning-budget`, жесткого лимита в tokens, который принудительно закрывает thinking.

## Взаимодействие с другими аргументами

- `--reasoning`: управляет включением thinking (`enable_thinking`); effort ортогонален и осмыслен только при включенном reasoning.
- `--reasoning-budget`: жесткий пост-фактум лимит tokens; effort — рекомендация модели до генерации. Совместимы: effort снижает аппетит, budget страхует сверху.
- `--chat-template-kwargs`: тот же механизм; для ключа `reasoning_effort` выигрывает последний аргумент в argv.
- `--jinja`: без Jinja rendering (legacy template) переменная не читается и аргумент инертен.
- `--reasoning-format`: не влияет на effort; определяет только parsing уже сгенерированных thoughts.

## INI-пресеты и router-режим

В `--models-preset` используйте `reasoning-effort = high` в секции модели — удобно держать разные уровни для разных моделей одного router-инстанса. Клиентское поле `reasoning_effort` в body по-прежнему перекрывает пресет.

## Типовые проблемы и диагностика

- Аргумент не влияет на вывод: template не поддерживает reasoning effort — проверьте в `/props` или логах capability `supports_reasoning_effort`, либо поищите `reasoning_effort`/`reasoning_strength` в тексте template.
- Значение как будто игнорируется: клиент шлет свое поле `reasoning_effort` в body — оно перекрывает серверный default.
- Ожидали ошибку на опечатку уровня: ее не будет — строка принимается любая, а template молча не распознает неизвестный уровень.

## Примеры

```bash
llama-server --model /models/gpt-oss-20b.gguf --reasoning-effort high
```

```bash
LLAMA_ARG_REASONING_EFFORT=low llama-server --model /models/gpt-oss-20b.gguf --reasoning-budget 2048
```

## Источники

- `llama.cpp/common/arg.cpp`: определение `--reasoning-effort`, запись в `default_template_kwargs`.
- `llama.cpp/common/chat.cpp`: чтение `reasoning_effort` из context при rendering.
- `llama.cpp/common/jinja/caps.cpp`: `caps_apply_reasoning_effort` (`reasoning_effort` + `reasoning_strength`), capability check `supports_reasoning_effort`.
- `llama.cpp/tools/server/server-common.cpp`: приоритет request body, особый случай `"none"`.
- Upstream commit `7e4c0a968` "chat : pass reasoning_effort to template".
