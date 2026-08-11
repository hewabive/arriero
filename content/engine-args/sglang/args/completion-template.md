---
schema: 1
engine: sglang
primaryName: "--completion-template"
title: "--completion-template"
summary: Включает FIM-обертку (fill-in-the-middle) для `/v1/completions`: поля `prompt` и `suffix` склеиваются служебными токенами модели. К чат-эндпоинтам отношения не имеет и без непустого `suffix` в запросе не срабатывает.
group: serving
related:
  - --chat-template
  - --hf-chat-template-name
  - --model-path
  - --served-model-name
---

# --completion-template

## Кратко

Аргумент существует ради одного сценария — кодового автодополнения. Клиент присылает на `/v1/completions` текст до курсора в `prompt` и текст после курсора в `suffix`, а SGLang собирает из них одну строку в FIM-разметке модели (`<|fim_prefix|>`, `<|fim_middle|>`, `<|fim_suffix|>` и аналоги). Без этого аргумента `suffix` в промпт не попадает вообще: OpenAI-схема его принимает, а SGLang молча игнорирует.

Механизм полностью независим от `--chat-template`: другой реестр, другой формат файла, другой эндпоинт.

## Оригинальная справка

```text
The buliltin completion template name or the path of the completion template file. This is only used for OpenAI-compatible API server. only for code completion currently.
```

## Паспорт аргумента

- Флаги: `--completion-template`
- Группа: `serving`
- Тип значения: строка — имя встроенного шаблона либо путь к `.json`
- Допустимые значения: `choices` нет. Встроенные имена лежат в реестре `completion_templates` (`sglang/python/sglang/srt/parser/code_completion_parser.py`), на checkout'е extract'а это `deepseek_coder`, `star_coder`, `qwen_coder`; список собирается при импорте модуля, поэтому статически не зафиксирован
- Значение по умолчанию: `null` — FIM-обертка отключена
- Эффективное значение: в `__post_init__` не переопределяется
- Где объявлен: `ServerArgs.completion_template`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: старт HTTP-слоя (`TemplateManager.initialize_templates`) → обработка каждого запроса к `/v1/completions`

## Что меняет в движке

`TemplateManager.load_completion_template` вызывается только если аргумент непустой. Порядок:

1. Имя есть в реестре `completion_templates` → `completion_template_name = <value>`.
2. Имени нет и `os.path.exists(value)` ложно → `RuntimeError: Completion template <value> is not a built-in template name or a valid completion template file path.` — сервер не стартует.
3. Иначе файл обязан быть `.json` (иначе `AssertionError: unrecognized format of completion template file`); из него собирается `CompletionTemplate` и регистрируется с `override=True`.

Дальше `set_completion_template` кладет имя в модульную глобальную переменную. Обратите внимание: `set_completion_template` присваивает только **если глобальная переменная еще `None`** — то есть повторной установки в рамках процесса не происходит.

В `OpenAIServingCompletions._convert_to_internal_request` (`sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`) обертка применяется так:

```python
prompt = request.prompt
if self.template_manager.completion_template_name is not None:
    prompt = generate_completion_prompt_from_request(request)
```

а сам `generate_completion_prompt_from_request` при `request.suffix == ""` возвращает `request.prompt` как есть. Склейка (`code_completion_parser.py`) зависит от `fim_position`:

- `FimPosition.MIDDLE`: `{begin}{prompt}{middle}{suffix}{end}` — так устроен `deepseek_coder`;
- `FimPosition.END`: `{begin}{prompt}{end}{suffix}{middle}` — так устроены `star_coder` и `qwen_coder`.

`/v1/chat/completions`, `/v1/responses` и нативный `/generate` этот код не проходят.

## Значения и формат

- **Встроенное имя.** Проверить список на своей сборке:

  ```bash
  python -c "from sglang.srt.parser.code_completion_parser import completion_templates; print(sorted(completion_templates))"
  ```

- **Путь к `.json`.** Обязательные ключи: `name`, `fim_begin_token`, `fim_middle_token`, `fim_end_token`, `fim_position`. Значение `fim_position` — строго `MIDDLE` или `END` (имена элементов перечисления `FimPosition`, регистр значим); что-то другое даёт `ValueError: Unknown fim position: <...>`.
- Токены задаются **строками**, а не id, и должны в точности совпадать со специальными токенами токенизатора модели.
- Особых значений (`auto`, `0`, пустая строка как «выключить») нет: не задан — обертки нет.

## Когда использовать

- Инстанс обслуживает inline-автодополнение в IDE (Continue, `llm.nvim`, свой плагин), клиент шлет `prompt` + `suffix`, модель обучена на FIM (DeepSeek-Coder, StarCoder, Qwen-Coder). Без аргумента модель получит только левый контекст и будет дописывать «в пустоту».
- **Не нужен**, если клиент шлет только `prompt` (обычная генерация) или работает через чат — обертка все равно не сработает, а неверные FIM-токены испортят промпт.
- **Не нужен** для моделей без FIM-обучения: вставленные служебные токены будут восприняты как мусор.

## Влияние на производительность и память

На VRAM, KV-пул и скорость не влияет: аргумент добавляет к промпту три коротких токена и меняет порядок конкатенации в процессе токенизатора. Косвенно — FIM-запросы обычно имеют другой префикс, чем чат-запросы, поэтому у смешанной нагрузки radix cache делится на две независимые ветки дерева.

## Взаимодействие с другими аргументами

- `--chat-template`: разные подсистемы. Оба грузятся из одного `TemplateManager.initialize_templates`, но реестры, форматы файлов и эндпоинты не пересекаются; задавать один вместо другого бессмысленно.
- `--model-path`: FIM-токены завязаны на конкретный токенизатор. Смена модели без смены шаблона — гарантированный мусор в промпте.
- `--served-model-name` на выбор шаблона не влияет.

## Типовые проблемы и диагностика

- `RuntimeError: Completion template <x> is not a built-in template name or a valid completion template file path.` — опечатка в имени или несуществующий путь.
- `AssertionError: unrecognized format of completion template file` — файл есть, но не `.json`.
- `ValueError: Unknown fim position: <...>` — в JSON значение `fim_position` не `MIDDLE` и не `END`.
- **Модель дописывает код, игнорируя правый контекст**: клиент не прислал `suffix` или прислал пустую строку — обертка в этом случае возвращает `prompt` без изменений. Проверяется телом запроса, не логом.
- **Модель выдает служебные токены в ответ**: FIM-токены шаблона не совпадают с токенизатором модели. Сверьте строки с `tokenizer.special_tokens_map` / `added_tokens.json` чекпойнта.
- Подтверждение загрузки: строка `Loading completion template: <value>` при старте плюс значение в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen2.5-Coder-7B --completion-template qwen_coder --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/deepseek-coder-6.7b-base --completion-template /models/templates/my-fim.json --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/parser/code_completion_parser.py`
- `sglang/python/sglang/srt/parser/template_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
