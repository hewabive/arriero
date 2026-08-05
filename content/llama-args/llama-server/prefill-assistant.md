---
schema: 1
primaryName: "--prefill-assistant"
title: "--prefill-assistant"
summary: "Разрешает использовать последний assistant message как prefill продолжения ответа. `--no-prefill-assistant` заставляет считать последний assistant message обычным завершенным сообщением."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--prefill-assistant"
  - "--no-prefill-assistant"
allowedValues: []
env:
  - "LLAMA_ARG_PREFILL_ASSISTANT"
related:
  - "--chat-template"
  - "--jinja"
  - "--reasoning"
---

# --prefill-assistant

## Кратко

`--prefill-assistant` управляет `common_params::prefill_assistant`. По умолчанию включен: если последний message в chat request имеет role `assistant`, server трактует его как начало ответа, который модель должна продолжить.

`--no-prefill-assistant` отключает эту эвристику и оставляет последний assistant message полноценным turn в истории.

## Оригинальная справка llama.cpp

```text
whether to prefill the assistant's response if the last message is an assistant message (default: prefill enabled)
when this flag is set, if the last message is an assistant message then it will be treated as a full message and not prefilled
```

## Паспорт аргумента

- Основное имя: `--prefill-assistant`
- Отрицательная форма: `--no-prefill-assistant`
- Поле `common_params`: `prefill_assistant`
- Переменная окружения: `LLAMA_ARG_PREFILL_ASSISTANT`
- По умолчанию: enabled
- Этап применения: per-request chat formatting

## Что меняет в llama-server

В `server-common.cpp`, если `continue_final_message` не задан, `prefill_assistant` включен и последний message имеет role `assistant`, server выставляет `inputs.continue_final_message = COMMON_CHAT_CONTINUATION_AUTO` и `add_generation_prompt = false`.

Если два или больше assistant messages идут в конце подряд, server бросает ошибку `Cannot have 2 or more assistant messages at the end of the list.`

## Значения и формат

Boolean-pair:

- `--prefill-assistant`: включить эвристику;
- `--no-prefill-assistant`: отключить.

В request body явное поле `continue_final_message` имеет приоритет над эвристикой.

## Когда использовать

Оставляйте включенным для OpenAI/vLLM-style workflows, где клиент хочет задать начало assistant ответа, например фиксированный JSON prefix или partial answer.

Отключайте, если ваши клиенты отправляют assistant messages только как историю и не ожидают continuation final message.

## Влияние на производительность и память

На модель и память напрямую не влияет. Prefill меняет prompt: последний assistant content становится частью входного контекста, а не новым generation prompt. Это может уменьшить или увеличить число prompt tokens в зависимости от template.

## Взаимодействие с другими аргументами

- `--chat-template` и `--jinja`: template должен корректно поддерживать continuation.
- `--reasoning`: если prefilled assistant message содержит только `reasoning_content`, auto continuation может выбрать reasoning continuation.
- `--skip-chat-parsing`: влияет на parsing результата, но не на prefill formatting.

## INI-пресеты и router-режим

В INI пишите `prefill-assistant = true` или `no-prefill-assistant = true`. Для router mode настройка должна соответствовать API-клиентам, которые ходят к конкретной модели.

## Типовые проблемы и диагностика

- Ошибка `Cannot set both add_generation_prompt and continue_final_message to true`: клиент явно конфликтует с continuation.
- Ошибка про два assistant messages в конце: нормализуйте историю перед запросом.
- Модель не продолжает заданный prefix: проверьте, что включен `--prefill-assistant` и последний message действительно `assistant`.

## Примеры

```bash
llama-server --model /models/model.gguf --prefill-assistant
```

```bash
llama-server --model /models/model.gguf --no-prefill-assistant
```

## Источники

- `llama.cpp/common/arg.cpp`: `--prefill-assistant`, `--no-prefill-assistant`.
- `llama.cpp/tools/server/server-common.cpp`: continuation heuristic.
- `llama.cpp/common/chat.cpp`: `continue_final_message` handling.
- `llama.cpp/tools/server/tests/unit/test_chat_completion.py`: coverage для continuation/prefill behavior.
