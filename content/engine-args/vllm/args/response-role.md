---
schema: 1
engine: vllm
primaryName: "--response-role"
title: "--response-role"
summary: Значение поля `role` в ответе чата, когда запрос просил добавить generation prompt. На сам промпт и на генерацию не влияет — это только разметка ответа.
group: Frontend
related:
  - --chat-template
  - --enable-auto-tool-choice
  - --return-tokens-as-token-ids
---

# --response-role

## Кратко

`--response-role` задает строку, которая уйдет в `choices[].message.role` (и в первый delta-чанк стрима) для запросов с `add_generation_prompt=true` — а это значение по умолчанию в OpenAI-схеме vLLM.

Если запрос продолжает последнее сообщение (`add_generation_prompt=false`, обычно вместе с `continue_final_message=true`), роль берется из последнего сообщения запроса, и аргумент не применяется.

## Оригинальная справка

```text
The role name to return if `request.add_generation_prompt=true`.
```

## Паспорт аргумента

- Флаги: `--response-role`
- Группа argparse: `Frontend`
- Тип значения: str
- Допустимые значения: не ограничены — движок не сверяет строку ни с каким списком ролей
- Значение по умолчанию: `assistant`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.response_role`
- Этап применения: HTTP-слой, сборка ответа

## Что меняет в движке

Значение доходит до `OpenAIServingChat.response_role`, `AnthropicServingMessages` и `CohereServingChatV2` (`vllm/entrypoints/generate/api_router.py`). Дальше используется в одном месте — `get_chat_request_role`:

```text
if request.add_generation_prompt: return self.response_role
return request.messages[-1]["role"]
```

Результат подставляется в `ChatMessage(role=...)` на нестриминговом пути и в первый `DeltaMessage(role=..., content="")` на стриминговом. Тот же выбор роли повторяется в батч-обработчике `OpenAIServingChatBatch`.

Ни промпт, ни sampling-параметры, ни разбор tool-call'ов от этого значения не зависят: шаблон получает сообщения запроса, а роль подставляется уже в сериализацию ответа.

## Значения и формат

- Произвольная строка; проверок нет. `--response-role bot` вернет `"role": "bot"` в ответе.
- Пустая строка технически принимается и даст `"role": ""` — клиентские SDK OpenAI на этом обычно спотыкаются при валидации ответа.
- Специальных значений (`auto`, `none`) нет.
- Не задано — `assistant`, то есть то, что ожидает любой OpenAI-совместимый клиент.

## Когда использовать

- Практически никогда на публичном OpenAI-совместимом эндпоинте: клиенты и SDK ожидают ровно `assistant`.
- Осмысленный случай — внутренний потребитель, который различает несколько источников ответа по полю `role` и не валидирует его по OpenAI-схеме.
- Не используйте как способ «пометить модель»: для идентификации есть `model` в ответе и `system_fingerprint`.

## Влияние на производительность и память

Не влияет: значение только подставляется в поле ответа, промпт и генерация от него не меняются.

## Взаимодействие с другими аргументами

- `--chat-template`: шаблон определяет роль в **промпте** (через `add_generation_prompt`), этот аргумент — роль в **ответе**. Они независимы, и рассогласование не вызовет ошибки, только странный ответ.
- `--enable-auto-tool-choice`: сообщение с `tool_calls` получает ту же роль; клиенты, отправляющие ответ обратно в диалог, будут возвращать ее в истории.
- `--return-tokens-as-token-ids`: другой аргумент, меняющий только форму ответа.

## Типовые проблемы и диагностика

- **Симптом:** клиент на официальном OpenAI SDK падает на валидации ответа. **Причина:** роль не `assistant`. **Проверка:** сырой ответ `curl` к `/v1/chat/completions`. **Лечение:** вернуть значение по умолчанию.
- **Симптом:** роль в ответе не совпадает с заданной. **Причина:** запрос пришел с `add_generation_prompt=false` (обычно вместе с `continue_final_message=true`), и роль скопирована из последнего сообщения. **Лечение:** действий не требуется, это документированное поведение.
- **Подтверждение принятого значения:** непустое значение видно в строке `non-default args: {...}` при старте и в поле `role` первого чанка стрима.

## Примеры

```bash
vllm serve /models/Qwen3-4B --response-role assistant --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --response-role bot --port 8000
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/openai/chat_completion/batch_serving.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
