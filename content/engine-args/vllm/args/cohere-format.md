---
schema: 1
engine: vllm
primaryName: "--cohere-format"
title: "--cohere-format"
summary: Выбор варианта промпта Command-моделей (`cmd4`/`cmd3`) при `--tokenizer-mode cohere`. На этом commit'е флаг до рендерера не доходит — рабочий путь идет через `--default-chat-template-kwargs`.
group: Frontend
related:
  - --tokenizer-mode
  - --default-chat-template-kwargs
  - --cohere-is-reasoning-model
  - --chat-template
---

# --cohere-format

## Кратко

В режиме `--tokenizer-mode cohere` промпт собирается не Jinja-шаблоном, а библиотекой `cohere_melody`, у которой два семейства шаблонов: `cmd4` (текущие Command A+) и `cmd3` (более ранние Cmd-A и Cmd-A reasoning). Ошибка выбора не диагностируется — модель просто получает промпт, на котором не обучалась.

Отдельный флаг задуман как удобная обертка над `chat_template_kwargs.cohere_format`. Однако в текущем коде значение подмешивается в словарь, который до рендерера не доходит: используйте `--default-chat-template-kwargs`.

## Оригинальная справка

```text
Cohere ``--tokenizer-mode cohere`` only. Which Cohere prompt
format to render: ``cmd4`` (current Command A+ models; default) or
``cmd3`` (earlier Cmd-A and Cmd-A reasoning models). Selecting the
wrong format silently produces a prompt the model wasn't trained
on, which most commonly manifests as the model emitting text but no
citations / tool calls / thinking blocks. Equivalent to passing
``--default-chat-template-kwargs '{"cohere_format": "..."}'`` -- any
explicit request-level ``chat_template_kwargs.cohere_format`` takes
priority.
```

## Паспорт аргумента

- Флаги: `--cohere-format`
- Группа argparse: `Frontend`
- Тип значения: str
- Допустимые значения: `choices` в extract нет; рендерер принимает только `cmd3` и `cmd4` (`_VALID_FORMATS` в `vllm/renderers/cohere.py`) и на прочих значениях бросает `ValueError` на запросе, а не на старте
- Значение по умолчанию: `cmd4`; тот же дефолт независимо продублирован в рендерере (`_DEFAULT_FORMAT`)
- Эффективное значение: `init_generate_state` делает `default_chat_template_kwargs.setdefault("cohere_format", args.cohere_format)` — то есть явный ключ в `--default-chat-template-kwargs` приоритетнее флага. Полученный словарь передается только serving-классам; **рендеринг** идет через `state.online_renderer`, собранный в `init_app_state` из необработанного `args.default_chat_template_kwargs`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.cohere_format`
- Этап применения: инициализация состояния генеративного роутера → HTTP-слой, сборка конфигурации рендеринга

## Что меняет в движке

`CohereRenderer.render_messages` (`vllm/renderers/cohere.py`) читает формат так:

```text
fmt = chat_template_kwargs.get("cohere_format", _DEFAULT_FORMAT)
```

и по нему выбирает `cohere_melody.render_cmd3` или `render_cmd4`. Форматы различаются набором слотов конфигурации: у cmd3 есть `citation_quality` и `skip_preamble`, у cmd4 — `grounding` и `platform_instruction`; преобразование полей Cohere v2 (`citation_options`, `thinking`, `response_format`) в эти слоты тоже разное.

`chat_template_kwargs` сюда приходит из `ChatParams`, собранных в `OnlineRenderer.preprocess_chat` из **его собственных** `default_chat_template_kwargs`. А `OnlineRenderer` создается в `init_app_state` с `default_chat_template_kwargs=args.default_chat_template_kwargs`, без подмешивания `--cohere-format`. Словарь с подмешанным `cohere_format` уходит в `OpenAIServingChat`/`CohereServingChatV2` и используется там лишь в `_effective_chat_template_kwargs` — для конструирования парсеров рассуждений и tool-call'ов.

Практический вывод: на commit'е `d6482361` установка `--cohere-format cmd3` не меняет рендеринг промпта — рендерер возьмет свой дефолт `cmd4`. Проверяется чтением `init_app_state` в `vllm/entrypoints/openai/api_server.py` и `init_generate_state` в `vllm/entrypoints/generate/api_router.py` вашей сборки.

## Значения и формат

- `cmd4` — текущие Command A+ модели, значение по умолчанию.
- `cmd3` — более ранние Cmd-A и Cmd-A reasoning.
- Любое другое значение принимается argparse'ом, но на первом же запросе дает `ValueError: Invalid cohere_format=<...>; expected one of ('cmd3', 'cmd4')`.
- Рабочая форма записи того же самого:

  ```text
  --default-chat-template-kwargs '{"cohere_format": "cmd3"}'
  ```

  Она доходит до рендерера, потому что этот словарь передается `OnlineRenderer` напрямую.
- Пер-запросное переопределение: `chat_template_kwargs: {"cohere_format": "cmd3"}` в теле запроса — оно перекрывает серверный дефолт (значения `null` и `"auto"` при слиянии игнорируются).

## Когда использовать

- Обслуживаете Cmd-A/Cmd-A reasoning предыдущего поколения в режиме `--tokenizer-mode cohere` — нужен `cmd3`, и задавать его следует через `--default-chat-template-kwargs`.
- Не задавайте на моделях вне Command-семейства: без `--tokenizer-mode cohere` рендерер `cohere` не выбирается и значение не читается никем.
- Не полагайтесь на отдельный флаг как на единственный способ задать формат, пока не проверили на своей сборке, что он доходит до рендерера (см. «Типовые проблемы»).

## Влияние на производительность и память

На VRAM, KV-cache и время старта не влияет. Влияет на длину и структуру промпта: cmd3 и cmd4 рендерят разные преамбулы, поэтому меняется число входных токенов и полностью обесценивается ранее накопленный prefix cache. Неверный формат косвенно бьет по throughput — модель, не узнавшая разметку, чаще генерирует лишний текст.

## Взаимодействие с другими аргументами

- `--tokenizer-mode`: значение `cohere` — обязательное условие, иначе рендерер не выбирается вовсе.
- `--default-chat-template-kwargs`: рабочий канал доставки формата; явный ключ `cohere_format` в нем приоритетнее флага (`setdefault`).
- `--cohere-is-reasoning-model`: относится к форме **ответа** на `/cohere/v2/chat`, а не к формату промпта; путать их легко.
- `--chat-template`: в этом режиме передается рендереру как `template_jinja`, то есть сырой шаблон, а не Jinja-путь vLLM.

## Типовые проблемы и диагностика

- **Симптом:** модель отвечает текстом, но не выдает цитат, tool-call'ов и блоков размышлений. **Причина:** промпт отрендерен не тем форматом. **Проверка:** `POST /tokenize` с теми же сообщениями — в отрендеренном промпте видно, какая преамбула использована. **Лечение:** задать формат через `--default-chat-template-kwargs '{"cohere_format": "cmd3"}'`.
- **Симптом:** `--cohere-format cmd3` задан, промпт не изменился. **Причина:** значение не доходит до `OnlineRenderer` (см. «Что меняет в движке»). **Проверка:** сравнить промпт из `POST /tokenize` при `--cohere-format cmd3` и при `--default-chat-template-kwargs '{"cohere_format": "cmd3"}'`. **Лечение:** использовать второй вариант.
- **Симптом:** запрос падает с `Invalid cohere_format=...; expected one of ('cmd3', 'cmd4')`. **Причина:** опечатка в значении; argparse его не проверяет. **Лечение:** исправить на `cmd3` или `cmd4`.
- **Симптом:** запрос падает с сообщением про отсутствующий пакет `cohere_melody`. **Причина:** режим `--tokenizer-mode cohere` требует этой библиотеки. **Лечение:** установить пакет в окружение либо не использовать этот режим токенизатора.
- **Подтверждение принятого значения:** отрендеренный промпт через `POST /tokenize`; отдельной строки лога у этого флага нет.

## Примеры

```bash
vllm serve /models/command-a --tokenizer-mode cohere --default-chat-template-kwargs '{"cohere_format": "cmd3"}'
```

```bash
vllm serve /models/command-a-plus --tokenizer-mode cohere --cohere-format cmd4
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/renderers/cohere.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/vllm/renderers/params.py`
- `vllm/vllm/config/model.py`
