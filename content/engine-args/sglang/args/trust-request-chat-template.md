---
schema: 1
engine: sglang
primaryName: "--trust-request-chat-template"
title: "--trust-request-chat-template"
summary: Разрешает клиенту подменять серверный chat-шаблон ключом `chat_template` в `chat_template_kwargs`. По умолчанию такой запрос отклоняется с 400; включать только для доверенных клиентов.
group: serving
related:
  - --chat-template
  - --default-chat-template-kwargs
  - --hf-chat-template-name
  - --api-key
  - --host
---

# --trust-request-chat-template

## Кратко

`chat_template_kwargs` из тела запроса SGLang передает в `tokenizer.apply_chat_template(**kwargs)`, а у этой функции есть параметр `chat_template` — целый Jinja-шаблон. Значит, клиент мог прислать собственный шаблон и полностью переопределить, как сервер собирает prompt: убрать системный промпт, подставить служебные токены, сломать разбор tool calls и reasoning, нагрузить рендеринг. Теперь такой запрос по умолчанию отклоняется, а этот флаг возвращает прежнее поведение. Остальные ключи `chat_template_kwargs` (`enable_thinking`, `reasoning_effort` и т. п.) флаг не затрагивает. Флаг новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Allow a request to override the server chat template via its chat_template_kwargs. Off by default for safety.
```

## Паспорт аргумента

- Флаги: `--trust-request-chat-template`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: есть / нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; `__post_init__` его не трогает
- Где объявлен: `python/sglang/srt/arg_groups/fields/serving.py:Serving.trust_request_chat_template`
- Статус: обычный
- Этап применения: HTTP-слой, валидация каждого чат-запроса (`OpenAIServingChat._validate_request`) до его преобразования во внутренний формат

## Что меняет в движке

Проверка в `OpenAIServingChat._validate_request` (`entrypoints/openai/serving_chat.py`):

```python
if (
    request.chat_template_kwargs
    and "chat_template" in request.chat_template_kwargs
    and not get_serving().trust_request_chat_template
):
    return ("Request-supplied chat_template is not allowed. Start the server "
            "with --trust-request-chat-template to permit it.")
```

Непустая строка из `_validate_request` превращается в ответ `400 BadRequestError` еще до токенизации (`OpenAIServingBase.handle_request`). Проверяется только наличие ключа: даже `"chat_template": null` отклоняется.

Где проверка действует в checkout'е — там, где вызывается `OpenAIServingChat._validate_request`:

- `/v1/chat/completions`;
- Anthropic-совместимый `/v1/messages` (обычный и стриминговый путь вызывают ту же валидацию после конвертации в чат-запрос);
- `/v1/tokenize` с полем `messages`.

Где ее нет: `/v1/responses` строит `ChatCompletionRequest` сам и сразу вызывает `_process_messages`, минуя `_validate_request`; `/v1/decisions` передает `chat_template_kwargs` из запроса в `apply_chat_template` напрямую со своей валидацией, которая этот ключ не проверяет. На этих путях подмена шаблона в checkout'е по-прежнему проходит независимо от флага.

Серверные значения `--default-chat-template-kwargs` подмешиваются уже после валидации (`_process_messages`, через `setdefault`), поэтому оператор может задать `chat_template` и там — флаг на это не влияет.

## Значения и формат

- Флаг без значения. Не задан — запросы с ключом `chat_template` в `chat_template_kwargs` получают 400.
- Задан — ключ проходит в `apply_chat_template` и переопределяет шаблон для этого запроса. Это работает только в Jinja-ветке рендеринга; при встроенном conv-шаблоне (`--chat-template <имя>`) `chat_template_kwargs` в prompt не попадают вовсе, но без флага запрос все равно отклоняется.

## Когда использовать

- Клиенты доверенные и им действительно нужен собственный шаблон на запрос: оценочные прогоны с разными шаблонами, отладка шаблона без перезапуска сервера.
- Не включайте на сервере, к которому ходят недоверенные клиенты: подмена шаблона дает полный контроль над тем, какой текст получает модель, а Jinja-рендеринг идет в процессе HTTP-сервера и может быть сколь угодно тяжелым.
- Серверный шаблон меняют `--chat-template` и `--hf-chat-template-name`, а не этот флаг.

## Влияние на производительность и память

На VRAM и скорость модели не влияет. Без флага — одна проверка ключа на запрос. С флагом запрос с собственным шаблоном рендерит присланный Jinja-шаблон в процессе HTTP-сервера (tokenizer manager), и тяжелый шаблон тормозит прием всех остальных запросов этого инстанса.

## Взаимодействие с другими аргументами

- `--chat-template`, `--hf-chat-template-name`: задают серверный шаблон, который запрос с флагом может переопределить.
- `--default-chat-template-kwargs`: применяется после валидации; запрет действует только на ключи, пришедшие в запросе.
- `--api-key`, `--host`: если флаг нужен, ограничьте круг клиентов ключом и привязкой к `127.0.0.1`.

## Типовые проблемы и диагностика

- Клиент получает 400 `Request-supplied chat_template is not allowed. Start the server with --trust-request-chat-template to permit it.` — клиент шлет `chat_template` в `chat_template_kwargs`. Либо убрать ключ на клиенте, либо включить флаг, если клиент доверенный.
- После обновления движка сломались клиенты, которые раньше передавали шаблон, — это ожидаемая смена поведения по умолчанию.
- Флаг выключен, а подмена шаблона через `/v1/responses` все равно работает — см. выше: этот путь проверку в checkout'е не вызывает; закрывайте его на уровне прокси.
- В arriero прокси пробрасывает `chat_template_kwargs` клиента в движок (в Anthropic-трансляции ключ входит в `basePassthroughKeys`, `packages/anthropic-openai-bridge/src/request.ts`, arriero), так что решение о доверии принимается на стороне движка этим флагом.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --api-key local-eval-key --trust-request-chat-template
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_responses.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_decisions.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_tokenize.py`
- `sglang/python/sglang/srt/entrypoints/anthropic/serving.py`
- arriero: `packages/anthropic-openai-bridge/src/request.ts`
