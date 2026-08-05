---
schema: 1
primaryName: "--reasoning"
title: "--reasoning"
summary: "Управляет тем, будет ли chat template просить модель генерировать reasoning/thinking. `auto` использует поддержку template, `on` принудительно включает template kwarg, `off` отключает."
category: "Параметры llama-server"
valueType: "enum"
estimation: "normal"
valueHint: "[on|off|auto]"
aliases:
  - "-rea"
  - "--reasoning"
allowedValues:
  - "on"
  - "off"
  - "auto"
env:
  - "LLAMA_ARG_REASONING"
related:
  - "--reasoning-format"
  - "--reasoning-budget"
  - "--reasoning-budget-message"
  - "--chat-template-kwargs"
  - "--jinja"
---

# --reasoning

## Кратко

`--reasoning` записывает `common_params::enable_reasoning`: `1` для включения, `0` для отключения, `-1` для auto. При `on`/`off` CLI также выставляет default `enable_thinking` в `default_template_kwargs`.

Аргумент влияет на то, просит ли chat template модель думать. Он не выбирает формат возврата reasoning в API; за это отвечает `--reasoning-format`.

## Оригинальная справка llama.cpp

```text
Use reasoning/thinking in the chat ('on', 'off', or 'auto', default: 'auto' (detect from template))
```

## Паспорт аргумента

- Основное имя: `--reasoning`
- Алиас: `-rea`
- Значения: `on`, `off`, `auto`; также принимаются truthy/falsey/auto формы парсера llama.cpp
- Поле `common_params`: `enable_reasoning`
- Дополнительно: `default_template_kwargs["enable_thinking"]` для `on` и `off`
- Переменная окружения: `LLAMA_ARG_REASONING`
- По умолчанию: `auto`

## Что меняет в llama-server

На старте server проверяет `params_base.use_jinja` и `common_chat_templates_support_enable_thinking()`. Итоговый `enable_thinking` становится true только если template поддерживает thinking и `--reasoning off` не был задан.

При обработке chat request это значение попадает в `common_chat_templates_inputs::enable_thinking`. Затем Jinja template получает переменную `enable_thinking`, а specialized/autoparser logic может добавить thinking tags и parser.

## Значения и формат

- `auto`: default; включить thinking, если template явно поддерживает `enable_thinking`.
- `on`: задать `enable_reasoning = 1` и default kwarg `enable_thinking = true`.
- `off`: задать `enable_reasoning = 0` и default kwarg `enable_thinking = false`.

Если передать неизвестную строку, CLI бросит `error: unknown value for --reasoning`.

## Когда использовать

- `auto`: нормальный режим для моделей с корректным Jinja template.
- `off`: публичный server, короткие ответы, embedding-adjacent workflows или модели, которые слишком часто раскрывают thinking.
- `on`: template поддерживает thinking, но auto-detect не сработал или нужен явный режим.

## Влияние на производительность и память

Thinking обычно увеличивает число генерируемых токенов, latency, стоимость CPU/GPU и занятость слота. На размер KV-cache per token не влияет, но длинное reasoning быстрее заполняет контекст. Для ограничения длины используйте `--reasoning-budget`.

## Взаимодействие с другими аргументами

- `--reasoning-format`: управляет parsing/возвратом thought content.
- `--reasoning-budget`: ограничивает токены внутри thinking block, если template дал start/end tags.
- `--chat-template-kwargs`: request-level `enable_thinking` может переопределить CLI default.
- `--jinja`: без Jinja auto thinking обычно недоступен.
- `--skip-chat-parsing`: thinking может быть сгенерирован, но попадет в обычный `content`.

## INI-пресеты и router-режим

В INI пишите `reasoning = off`, `reasoning = on` или `reasoning = auto`. Для router mode задавайте значение на уровне модели: reasoning-поведение сильно зависит от template конкретной модели.

## Типовые проблемы и диагностика

- В логе `chat template, thinking = 0`: template не поддерживает thinking, Jinja выключен или задан `--reasoning off`.
- Модель продолжает писать `<think>` при `--reasoning off`: template мог не поддерживать управляющий kwarg, или это поведение самой модели.
- API не возвращает `reasoning_content`: проверьте `--reasoning-format`, а не только `--reasoning`.
- Warning про deprecated `enable_thinking` в kwargs: перенесите настройку в `--reasoning`.

## Примеры

```bash
llama-server --model /models/reasoning.gguf --reasoning auto
```

```bash
llama-server --model /models/reasoning.gguf --reasoning off
```

## Источники

- `llama.cpp/common/arg.cpp`: parsing `--reasoning`.
- `llama.cpp/tools/server/server-context.cpp`: вычисление `chat template, thinking`.
- `llama.cpp/tools/server/server-common.cpp`: request-level kwargs и `enable_thinking`.
- `llama.cpp/common/chat.cpp`: Jinja variable `enable_thinking`.
