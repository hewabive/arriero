---
schema: 1
engine: vllm
primaryName: "--default-chat-template-kwargs"
title: "--default-chat-template-kwargs"
summary: Серверные значения по умолчанию для переменных Jinja-шаблона чата — например `enable_thinking`. Запрос может их переопределить, поэтому это дефолт, а не запрет.
group: Frontend
related:
  - --chat-template
  - --chat-template-content-format
  - --trust-request-chat-template
  - --cohere-format
  - --reasoning-parser
---

# --default-chat-template-kwargs

## Кратко

Аргумент задает словарь, который подмешивается под `chat_template_kwargs` каждого чат-запроса. Это единственный способ поменять поведение штатного шаблона модели (режим размышлений, формат преамбулы), не копируя весь шаблон в файл.

Приоритет однозначный: значения запроса перекрывают серверные — но только если они не `null` и не `"auto"`.

## Оригинальная справка

```text
Default keyword arguments to pass to the chat template renderer.
These will be merged with request-level chat_template_kwargs,
with request values taking precedence. Useful for setting default
behavior for reasoning models. Example: '{"enable_thinking": false}'
to disable thinking mode by default for Qwen3/DeepSeek models.
```

## Паспорт аргумента

- Флаги: `--default-chat-template-kwargs`
- Группа argparse: `Frontend`
- Тип значения: JSON-объект (`type=json.loads`, задается в `BaseFrontendArgs._customize_cli_kwargs`)
- Допустимые значения: любой JSON-объект; ключи должны быть переменными шаблона, иначе будут отброшены
- Значение по умолчанию: `None` — словарь пуст
- Эффективное значение: `OnlineRenderer` хранит `args.default_chat_template_kwargs or {}`; в serving-классы генеративного роутера передается тот же словарь **плюс** ключ `cohere_format` из `--cohere-format` (через `setdefault`, то есть явный ключ в JSON выигрывает)
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.default_chat_template_kwargs`
- Этап применения: HTTP-слой, сборка `ChatParams` каждого чат-запроса перед применением шаблона

## Что меняет в движке

Словарь попадает в `OnlineRenderer.default_chat_template_kwargs` и в `ServingTokenization`. На каждый запрос `preprocess_chat` (`vllm/renderers/online_renderer.py`) делает так:

1. к серверным умолчаниям добавляются вычисляемые ключи `tools` (описания инструментов запроса) и `tokenize`;
2. `ChatParams.with_defaults(...)` сливает их с `chat_template_kwargs` запроса через `merge_kwargs(defaults, overrides)` (`vllm/renderers/params.py`);
3. `safe_apply_chat_template` → `resolve_chat_template_kwargs` (`vllm/renderers/hf.py`) отфильтровывает все, что не является ни переменной шаблона, ни параметром `apply_chat_template` — лишние ключи не вызывают ошибку, они просто исчезают.

`merge_kwargs` имеет важную деталь: из перекрывающих значений выбрасываются `None` и строка `"auto"`. Клиент, приславший `chat_template_kwargs: {"enable_thinking": null}`, **не** отменит серверный дефолт — он получит серверное значение.

Ключ `chat_template` в этом словаре — особый случай. `ChatParams.get_apply_chat_template_kwargs()` дописывает поверх `chat_template=<серверный или запросный шаблон>`, но по правилу `merge_kwargs` значение `None` отбрасывается. Значит при отсутствии `--chat-template` и шаблона в запросе ключ `chat_template` из этого JSON доедет до `apply_chat_template` как настоящий шаблон. Не используйте его так — для шаблона есть `--chat-template`; на запросном уровне тот же ключ отдельно закрыт `--trust-request-chat-template`.

## Значения и формат

Две эквивалентные формы записи.

- Одной строкой JSON: `--default-chat-template-kwargs '{"enable_thinking": false}'`.
- Точечными под-флагами `FlexibleArgumentParser`: `--default-chat-template-kwargs.enable_thinking false`. Пре-пасс `parse_args` собирает все точечные ключи в один словарь и подставляет его как JSON. Списковая форма — `--default-chat-template-kwargs.key+ a,b`.
- Смешивать формы не стоит: собранный из точечных ключей аргумент дописывается в конец командной строки и перекрывает явный JSON целиком, а не по ключам.
- Невалидный JSON — это ошибка argparse: процесс завершается с кодом 2 еще до загрузки модели (`tests/entrypoints/openai/test_cli_args.py::test_default_chat_template_kwargs_invalid_json`).
- Значение по умолчанию `None` и пустой объект `{}` эквивалентны по эффекту.

## Когда использовать

- Модели семейств Qwen3/DeepSeek с переключателем размышлений: `{"enable_thinking": false}` отключает `<think>`-блоки по умолчанию, оставляя клиенту возможность включить их обратно.
- Нужно задать переменную, которую шаблон читает, а API не выставляет (кастомная преамбула, `dev_instruction`, флаги форматирования).
- Не используйте как запрет: любой клиент вернет прежнее поведение своим `chat_template_kwargs`. Если поведение должно быть жестким — правьте шаблон и подставляйте его через `--chat-template`.
- Не кладите сюда ключи, которых нет в шаблоне: они молча отбрасываются, и «настройка не работает» выглядит как баг движка.

## Влияние на производительность и память

На VRAM, KV-cache и время старта не влияет. Косвенно влияет на длину промпта и на длину ответа: отключение режима размышлений убирает и блок рассуждений из генерации, что заметно снижает число выходных токенов на запрос.

## Взаимодействие с другими аргументами

- `--chat-template`: словарь осмыслен только относительно переменных конкретного шаблона; после смены шаблона набор принимаемых ключей меняется.
- `--chat-template-content-format`: ключ `tools` в собранных kwargs участвует в разрешении шаблона, а значит влияет на автоопределение формата контента.
- `--trust-request-chat-template`: закрывает запросный `chat_template_kwargs.chat_template`; серверный словарь этой проверкой не ограничен.
- `--cohere-format`: подставляется в этот же словарь через `setdefault`, поэтому явный ключ `cohere_format` в JSON приоритетнее отдельного флага.
- `--reasoning-parser`: парсер рассуждений разбирает то, что шаблон включил; отключив `enable_thinking`, вы оставите парсер без входа.

## Типовые проблемы и диагностика

- **Симптом:** сервер не стартует, argparse ругается на значение. **Причина:** невалидный JSON или потерянные кавычки в shell. **Лечение:** одинарные кавычки вокруг всего JSON либо точечные под-флаги.
- **Симптом:** ключ задан, поведение не изменилось. **Причина:** такой переменной нет в шаблоне — `resolve_chat_template_kwargs` ее отбросил. **Проверка:** `GET /tokenizer_info` (при `--enable-tokenizer-info-endpoint`) показывает текст шаблона; сравните имя переменной. **Лечение:** использовать имя из шаблона.
- **Симптом:** клиент присылает `{"enable_thinking": null}` и ожидает поведения «как без сервера», а получает серверное значение. **Причина:** `merge_kwargs` считает `None` и `"auto"` за «не задано». **Лечение:** прислать конкретное `true`/`false`.
- **Симптом:** `/v1/chat/completions` учитывает ключ, а `POST /tokenize` — нет (или наоборот) для `cohere_format`. **Причина:** `ServingTokenization` получает `args.default_chat_template_kwargs` без подмешивания `--cohere-format`. **Лечение:** задавать `cohere_format` прямо в этом JSON.
- **Подтверждение принятого значения:** строка `non-default args: {...}` в логе старта содержит разобранный словарь.

## Примеры

```bash
vllm serve /models/Qwen3-4B --default-chat-template-kwargs '{"enable_thinking": false}' --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --default-chat-template-kwargs.enable_thinking false --reasoning-parser deepseek_r1
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/renderers/params.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/vllm/renderers/hf.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/tests/entrypoints/openai/test_cli_args.py`
