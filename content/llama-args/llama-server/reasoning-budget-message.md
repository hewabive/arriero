---
schema: 1
primaryName: "--reasoning-budget-message"
title: "--reasoning-budget-message"
summary: "Сообщение, которое sampler вставляет перед end-of-thinking tag, когда `--reasoning-budget` исчерпан. Не действует без активного reasoning budget и thinking tags в template."
category: "Параметры llama-server"
valueType: "string"
estimation: "normal"
valueHint: "MESSAGE"
aliases:
  - "--reasoning-budget-message"
allowedValues: []
env:
  - "LLAMA_ARG_THINK_BUDGET_MESSAGE"
related:
  - "--reasoning-budget"
  - "--reasoning"
  - "--reasoning-format"
---

# --reasoning-budget-message

## Кратко

`--reasoning-budget-message` записывает строку в `common_params::sampling.reasoning_budget_message`. Когда reasoning budget заканчивается, server токенизирует `message + end_tag` и sampler форсирует эту последовательность.

По умолчанию сообщение пустое, поэтому при исчерпании budget форсируется только end-of-thinking tag.

## Оригинальная справка llama.cpp

```text
message injected before the end-of-thinking tag when reasoning budget is exhausted (default: none)
```

## Паспорт аргумента

- Основное имя: `--reasoning-budget-message`
- Значение: строка `MESSAGE`
- Поле `common_params`: `sampling.reasoning_budget_message`
- Переменная окружения: `LLAMA_ARG_THINK_BUDGET_MESSAGE`
- По умолчанию: пустая строка
- Этап применения: tokenization при создании server task

## Что меняет в llama-server

`server-task.cpp` читает `reasoning_budget_message`, соединяет его с `reasoning_budget_end_tag` и вызывает `common_tokenize(vocab, message + end_tag, false, true)`. Полученные токены становятся `reasoning_budget_forced`.

Если budget не активировался, сообщение не появляется. Если budget исчерпан, сообщение становится частью сгенерированного текста в reasoning block перед закрывающим tag.

## Значения и формат

Это обычная строка. Если нужны переводы строк или кавычки, учитывайте quoting argv/INI. При включенном `--escape` CLI post-processing обрабатывает escapes только для prompt/prefix/suffix/antiprompt/seq_breakers, не для этого поля.

## Когда использовать

- Нужно явно обозначить в reasoning, что внутреннее рассуждение было остановлено лимитом.
- Клиенту или UI важно отличать естественное завершение thinking от принудительного.
- Вы используете очень маленький `--reasoning-budget` и хотите дать модели мягкий переход к финальному ответу.

## Влияние на производительность и память

Сообщение добавляет свои токены к forced sequence. Обычно влияние минимально, но длинное сообщение частично нивелирует экономию от малого budget.

## Взаимодействие с другими аргументами

- `--reasoning-budget`: без неограниченного/активного budget message не используется.
- `--reasoning-format`: определяет, попадет ли forced message в `reasoning_content` или останется в `content`.
- `--reasoning`: если thinking выключен и tags не генерируются, sampler не активируется.

## INI-пресеты и router-режим

В INI используйте `reasoning-budget-message = ...`. Для router mode задавайте сообщение в секции модели, чтобы оно соответствовало языку/формату конкретного template.

## Типовые проблемы и диагностика

- Сообщение не видно: budget не исчерпан или не было thinking start tag.
- Сообщение видно пользователю в `content`: выбран `--reasoning-format none`, `deepseek-legacy` или включен `--skip-chat-parsing`.
- Модель продолжает reasoning после сообщения: проверьте, что end tag корректно определяется template и токенизируется.

## Примеры

```bash
llama-server --model /models/reasoning.gguf --reasoning on --reasoning-budget 128 --reasoning-budget-message "Reasoning budget exhausted."
```

## Источники

- `llama.cpp/common/arg.cpp`: `--reasoning-budget-message`.
- `llama.cpp/tools/server/server-common.cpp`: передача message вместе с tags.
- `llama.cpp/tools/server/server-task.cpp`: tokenization `message + end_tag`.
- `llama.cpp/common/reasoning-budget.cpp`: forced sequence logic.
