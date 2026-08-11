---
schema: 1
engine: sglang
primaryName: "--default-chat-template-kwargs"
title: "--default-chat-template-kwargs"
summary: JSON-объект с переменными, которые подставляются в chat-шаблон каждого запроса, если клиент не задал их сам. Основной практический смысл — серверный дефолт для `enable_thinking`/`thinking`/`reasoning_effort`.
group: serving
related:
  - --chat-template
  - --hf-chat-template-name
  - --reasoning-parser
  - --enable-strict-thinking
  - --tool-call-parser
---

# --default-chat-template-kwargs

## Кратко

Chat-шаблоны современных моделей принимают переменные помимо `messages`: `enable_thinking`, `thinking`, `reasoning_effort` и т. п. По OpenAI-протоколу клиент передает их в `chat_template_kwargs`. Этот аргумент задает серверные значения по умолчанию — они применяются только к тем ключам, которых в запросе нет.

Ключи не валидируются против шаблона: если имя переменной не то, которое ждет шаблон, никакой ошибки не будет — Jinja просто получит неиспользуемую переменную, а нужная останется в дефолте шаблона.

## Оригинальная справка

```text
Default chat template kwargs applied to every request when not overridden per-request. Keys must match what the model's chat template expects (e.g. enable_thinking, thinking, reasoning_effort). Per-request chat_template_kwargs takes precedence.
```

## Паспорт аргумента

- Флаги: `--default-chat-template-kwargs`
- Группа: `serving`
- Тип значения: JSON-объект (в extract `type: json`), разбирается `json.loads` на этапе argparse
- Допустимые значения: `choices` нет. Имена ключей диктует chat-шаблон конкретной модели; значения — любые JSON-типы
- Значение по умолчанию: `null` — ничего не подставляется
- Эффективное значение: `__post_init__` значение не меняет, но `_handle_other_validations` требует, чтобы результат разбора был именно объектом
- Где объявлен: `ServerArgs.default_chat_template_kwargs`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`json.loads`) → валидация в `__post_init__` → рендеринг каждого запроса к `/v1/chat/completions`

## Что меняет в движке

Значение читается один раз в конструкторе `OpenAIServingChat` (`self.default_chat_template_kwargs = server_args.default_chat_template_kwargs or {}`) и применяется в начале `_process_messages`:

```python
if self.default_chat_template_kwargs:
    ctk = dict(request.chat_template_kwargs or {})
    for k, v in self.default_chat_template_kwargs.items():
        ctk.setdefault(k, v)
    request.chat_template_kwargs = ctk
    effort = ctk.get("reasoning_effort")
    if effort is not None and request.reasoning_effort is None:
        request.reasoning_effort = effort
```

Три следствия, каждое важно:

1. **`setdefault`, а не `update`** — значение из тела запроса всегда сильнее серверного. Приоритет: `request.chat_template_kwargs` → `--default-chat-template-kwargs` → дефолт внутри самого шаблона.
2. **`reasoning_effort` вытягивается наверх** — если он оказался среди kwargs (из запроса или из дефолта) и поле `request.reasoning_effort` пустое, оно заполняется. Дальше это влияет на маппинг effort'а в `_apply_jinja_template` и на предупреждение о моделях, поддерживающих только `low`.
3. **Работает только в Jinja-ветке рендеринга.** В `_apply_jinja_template` собранный словарь уходит в `apply_chat_template(**extra_template_kwargs)`. Если `TemplateManager.chat_template_name` не `None` (задано имя встроенного conv-шаблона или сработало угадывание по пути модели), рендеринг идет через `_apply_conversation_template`, куда kwargs не передаются вообще — аргумент молча не действует.

Отдельно: в `_convert_to_internal_request` из `request.chat_template_kwargs` извлекается (`pop`) ключ `reasoning_effort`, а `spaces_between_special_tokens` из того же словаря читается в `to_sampling_params`. То есть словарь используется не только шаблоном.

## Значения и формат

- Одна JSON-строка в кавычках оболочки: `--default-chat-template-kwargs '{"enable_thinking": false}'`.
- Верхний уровень обязан быть объектом. Иначе — `ValueError: --default-chat-template-kwargs must decode to a JSON object` при инициализации `ServerArgs`.
- Невалидный JSON отвергает argparse на этапе разбора (`json.loads` как `type`).
- Значения передаются в Jinja как есть: `false` — булево, `"false"` — строка. Для `enable_thinking` это критично: строка `"false"` в Jinja истинна.
- Специальных значений (`null`, `auto`, пустой объект) нет; `{}` эквивалентен «не задан» — проверка `if self.default_chat_template_kwargs:` falsy для пустого словаря.
- Имя ключа определяется шаблоном модели. Qwen3 и родственники ждут `enable_thinking`, часть моделей — `thinking`, часть — `reasoning_effort`. Посмотреть, что читает шаблон:

  ```bash
  python -c "from transformers import AutoTokenizer; print(AutoTokenizer.from_pretrained('/models/model').chat_template)" | grep -o 'enable_thinking\|thinking\|reasoning_effort' | sort -u
  ```

## Когда использовать

- Нужно, чтобы инстанс по умолчанию отвечал **без** reasoning, а клиент мог включить его точечно: `--default-chat-template-kwargs '{"enable_thinking": false}'`. Обратная настройка (включить по умолчанию) — то же самое с `true`.
- Нужно зафиксировать серверный `reasoning_effort` для клиентов, которые его не передают.
- **Не подходит** для «выключить thinking» у моделей, где reasoning вшит в веса, а не в шаблон: там переменной в шаблоне нет, и подстановка ничего не изменит.
- **Не подходит** для управления sampling-параметрами — это `--preferred-sampling-params` и `--sampling-defaults`.

## Влияние на производительность и память

Прямого влияния нет. Косвенное — существенное: выключенный thinking режет длину генерации в разы, что снижает занятость KV-пула и время ответа; включенный, наоборот, увеличивает и то и другое. Сам разбор словаря — один `dict()` и несколько `setdefault` на запрос.

## Взаимодействие с другими аргументами

- `--chat-template`: если он выбрал встроенный conv-шаблон, аргумент не действует (см. выше). Если указан `.jinja` — действует нормально.
- `--hf-chat-template-name`: разные именованные шаблоны одной модели могут ждать разные имена переменных; меняя имя шаблона, перепроверьте ключи.
- `--reasoning-parser`: определяет, как разбирается **вывод** модели с reasoning. Этот аргумент управляет **входом**. Выключив thinking в шаблоне, но оставив парсер, вы получите пустое `reasoning_content` — это норма, а не поломка.
- `--enable-strict-thinking`: работает поверх включенного reasoning; при `enable_thinking: false` фильтровать будет нечего.

## Типовые проблемы и диагностика

- `ValueError: --default-chat-template-kwargs must decode to a JSON object` — на входе валидный JSON, но не объект (список, число, строка).
- Ошибка argparse о значении `loads` — строка вообще не парсится как JSON; чаще всего это съеденные оболочкой кавычки.
- **Аргумент задан, thinking не выключился**: три причины по убыванию частоты — (1) ключ не тот, что читает шаблон; (2) рендеринг ушел в conv-ветку (в логе есть `Loading chat template from argument:` или `Inferred chat template from model path:`); (3) клиент сам прислал `chat_template_kwargs` с этим ключом и перебил дефолт.
- Проверка без гадания: нестриминговый запрос к `/v1/chat/completions` с `"return_prompt_token_ids": true` и `"max_tokens": 1` — детокенизировав `prompt_token_ids`, вы увидите, попал ли в промпт блок `<think>`.
- Принятое значение видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --default-chat-template-kwargs '{"enable_thinking": false}' --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --default-chat-template-kwargs '{"enable_thinking": true}' --reasoning-parser qwen3 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/parser/template_manager.py`
- `sglang/python/sglang/srt/parser/reasoning_parser.py`
