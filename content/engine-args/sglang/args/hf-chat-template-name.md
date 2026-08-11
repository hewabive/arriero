---
schema: 1
engine: sglang
primaryName: "--hf-chat-template-name"
title: "--hf-chat-template-name"
summary: Выбирает один из нескольких именованных chat-шаблонов HuggingFace-токенизатора. Работает только тогда, когда `--chat-template` не задан и шаблон в токенизаторе лежит словарем; иначе аргумент не читается вообще.
group: serving
related:
  - --chat-template
  - --tokenizer-path
  - --default-chat-template-kwargs
  - --tool-call-parser
  - --model-path
---

# --hf-chat-template-name

## Кратко

У части моделей поле `chat_template` в токенизаторе — не строка, а словарь вида `{"default": ..., "tool_use": ..., "rag": ...}`. По умолчанию SGLang берет **первый ключ словаря** — то есть порядок вставки в JSON, а не какой-то осмысленный выбор. `--hf-chat-template-name` фиксирует нужное имя явно.

Аргумент участвует ровно в одной точке цепочки разрешения шаблона и полностью игнорируется, если шаблон был получен любым другим способом.

## Оригинальная справка

```text
When the HuggingFace tokenizer has multiple chat templates (e.g., 'default', 'tool_use', 'rag'), specify which named template to use. If not set, the first available template is used.
```

## Паспорт аргумента

- Флаги: `--hf-chat-template-name`
- Группа: `serving`
- Тип значения: строка — ключ словаря `chat_template`
- Допустимые значения: `choices` нет; допустимые имена определяются самой моделью (ключи словаря `chat_template` в `tokenizer_config.json` / `chat_template.json`). Неизвестное имя — ошибка старта со списком доступных
- Значение по умолчанию: `null` — «взять первый ключ словаря»
- Эффективное значение: не переопределяется в `__post_init__`; но фактически применяется только внутри `TemplateManager._select_named_template`
- Где объявлен: `ServerArgs.hf_chat_template_name`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: старт HTTP-слоя, `TemplateManager.load_chat_template` до приема запросов

## Что меняет в движке

`_resolve_hf_chat_template` (`sglang/python/sglang/srt/parser/template_manager.py`) берет `processor.chat_template`, а если процессора нет — `tokenizer.chat_template`. Если результат — `dict`, управление уходит в `_select_named_template`:

```python
if preferred_name := tokenizer_manager.server_args.hf_chat_template_name:
    if preferred_name not in templates:
        raise ValueError(
            f"Specified template '{preferred_name}' not found. "
            f"Available templates: {available_names}"
        )
    return templates[preferred_name]
first_name = available_names[0]
return templates[first_name]
```

Выбранная строка кладется обратно в `tokenizer.chat_template`, по ней определяется content format (`openai`/`string`) и по ней же затем идет автодетект reasoning/tool-парсеров (`_run_template_detection`). То есть выбор шаблона влияет не только на разметку промпта, но и на то, какие парсеры SGLang предложит.

Три условия, при которых аргумент **не будет прочитан ни разу**:

1. задан `--chat-template` — цепочка уходит в `_load_explicit_chat_template` и HF-шаблон не запрашивается;
2. путь модели совпал с одной из матчинг-функций `conversation.py` (мультимодальные и OCR-модели) — используется встроенный conv-шаблон;
3. `chat_template` в токенизаторе — обычная строка, а не словарь (подавляющее большинство моделей).

Во всех трех случаях неверное значение аргумента не вызовет ни ошибки, ни предупреждения — оно просто не сработает.

## Значения и формат

- Строка, ровно совпадающая с ключом словаря. Регистр значим.
- Типичные ключи из практики HF: `default`, `tool_use`, `rag`. Реальный список печатается в лог при старте (`Multiple HuggingFace chat templates available: [...]`) и виден напрямую:

  ```bash
  python -c "from transformers import AutoTokenizer; t=AutoTokenizer.from_pretrained('/models/model'); print(type(t.chat_template), list(t.chat_template) if isinstance(t.chat_template, dict) else 'single string')"
  ```

- Пустая строка эквивалентна «не задан»: проверка `if preferred_name := ...` — falsy.
- Значений «авто»/«все» нет: либо конкретное имя, либо первый ключ.

## Когда использовать

- Модель публикует отдельный `tool_use`-шаблон, а вы обслуживаете tool calling: без явного выбора можно молча уехать на `default`, где описания инструментов в промпт не попадают.
- Модель публикует `rag`-шаблон с другим форматом источников — тот же случай.
- **Не нужен**, если в логе старта нет строки `Multiple HuggingFace chat templates available:`. Ее отсутствие означает, что шаблон один, и аргумент бесполезен.

## Влияние на производительность и память

На память и скорость не влияет: выбор делается один раз при старте и меняет только текст промпта. Разные именованные шаблоны дают разной длины префикс, что косвенно меняет число prefill-токенов.

## Взаимодействие с другими аргументами

- `--chat-template`: взаимно исключающие по факту. Заданный `--chat-template` отключает весь блок разрешения HF-шаблона вместе с этим аргументом.
- `--tokenizer-path`: словарь шаблонов читается из токенизатора (и из процессора у мультимодальных), то есть отсюда. При разъехавшихся `--model-path` и `--tokenizer-path` смотреть надо на второй.
- `--tool-call-parser` / `--reasoning-parser`: подсказки автодетекта считаются по выбранному шаблону — смена имени может изменить строку `Auto-detected template features: …`.
- `--default-chat-template-kwargs`: kwargs передаются в выбранный шаблон; если у `tool_use`- и `default`-вариантов разные имена переменных (`enable_thinking` против `thinking`), набор kwargs придется менять вместе с именем шаблона.

## Типовые проблемы и диагностика

- `ValueError: Specified template '<x>' not found. Available templates: [...]` при старте — опечатка в имени. Список доступных прямо в сообщении.
- Аргумент задан, но эффекта нет и ошибки нет: сработало одно из трех условий выше. Проверьте лог на `Loading chat template from argument:` (задан `--chat-template`), `Inferred chat template from model path:` (угадали conv-шаблон) — при любой из них аргумент мертв.
- Подтверждение выбора в логе: `Multiple HuggingFace chat templates available: ['default', 'tool_use']`, затем либо `Using specified chat template: 'tool_use'`, либо `Using first available template: 'default'`.
- Принятое значение аргумента видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Hermes-3-Llama-3.1-8B --hf-chat-template-name tool_use --tool-call-parser hermes --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Hermes-3-Llama-3.1-8B --hf-chat-template-name default --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/parser/template_manager.py`
- `sglang/python/sglang/srt/parser/conversation.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
