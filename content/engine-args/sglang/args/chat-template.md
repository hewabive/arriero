---
schema: 1
engine: sglang
primaryName: "--chat-template"
title: "--chat-template"
summary: Переопределяет шаблон диалога для OpenAI-совместимого сервера. Принимает имя встроенного conv-шаблона, путь к `.jinja` или путь к `.json`; неверное значение не роняет сервер, а тихо портит промпт — это самая частая причина «здоровый сервер, мусор в ответе».
group: serving
related:
  - --hf-chat-template-name
  - --completion-template
  - --default-chat-template-kwargs
  - --reasoning-parser
  - --tool-call-parser
  - --model-path
  - --tokenizer-path
---

# --chat-template

## Кратко

`--chat-template` управляет только тем, как список `messages` превращается в строку промпта на OpenAI-совместимых эндпоинтах (`/v1/chat/completions`, `/v1/responses`, conv-путь эмбеддингов). Нативный `/generate` и `/v1/completions` его не видят вовсе.

Ключевая опасность в том, что аргумент выбирает не просто «другой текст», а **другой движок рендеринга**. Если итоговое имя шаблона (`TemplateManager.chat_template_name`) оказалось не `None`, SGLang перестает вызывать `tokenizer.apply_chat_template` и собирает промпт классом `Conversation` из `conversation.py` — без `tools`, без `chat_template_kwargs`, с фиксированными разделителями. Модель при этом остается «здоровой»: сервер стартует, `/health` отвечает, токены генерируются — просто структура промпта не та, которую модель видела при обучении.

## Оригинальная справка

```text
The buliltin chat template name or the path of the chat template file. This is only used for OpenAI-compatible API server.
```

## Паспорт аргумента

- Флаги: `--chat-template`
- Группа: `serving`
- Тип значения: строка — имя встроенного шаблона либо путь к файлу
- Допустимые значения: `choices` нет. Список встроенных имен собирается в runtime из глобального реестра `chat_templates` в `sglang/python/sglang/srt/parser/conversation.py` (заполняется вызовами `register_conv_template` при импорте модуля), поэтому статически он не зафиксирован; см. «Значения и формат»
- Значение по умолчанию: `null` — «шаблон подберет движок»
- Эффективное значение: при `null` работает цепочка автоподбора `TemplateManager.load_chat_template` (по пути модели → HF-шаблон токенизатора/процессора → отсутствие шаблона). `__post_init__` это поле не трогает
- Где объявлен: `ServerArgs.chat_template`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: старт HTTP-слоя (`TemplateManager.initialize_templates` до приема запросов) → рендеринг каждого запроса к `/v1/chat/completions`

## Что меняет в движке

### Порядок разрешения, когда аргумент НЕ задан

`TemplateManager.load_chat_template` (`sglang/python/sglang/srt/parser/template_manager.py`) идет строго по этим шагам:

1. **Угадывание по пути модели** — `get_conv_template_by_model_path(model_path)` прогоняет путь через все функции, зарегистрированные `@register_conv_template_matching_function` в `conversation.py`. Это регулярки и проверка `model_type` из `config.json` (`match_vicuna`, `match_qwen_chat_ml`, `match_minicpm`, `match_internvl`, `match_deepseek_vl`, `match_phi_4_mm`, `match_whisper`, `match_paddle_ocr` и др.). Совпадение → лог `Inferred chat template from model path: <name>`, и HF-шаблон **больше не рассматривается**. Практически весь этот набор — мультимодальные и OCR-модели; для обычной текстовой LLM совпадений нет.
2. **HF-шаблон** — `_resolve_hf_chat_template` берет `processor.chat_template`, а если процессора нет — `tokenizer.chat_template`. Это тот самый `chat_template.jinja` / поле в `tokenizer_config.json` из репозитория модели. Если значение — словарь именованных шаблонов, выбор делает `--hf-chat-template-name` (по умолчанию — **первый** ключ). Найденный текст присваивается обратно в `tokenizer.chat_template`, определяется content format, в лог идет `Using default HuggingFace chat template with detected content format: openai|string`.
3. **Ничего не нашлось** — `No HuggingFace chat template found` (warning) плюс `No chat template found, defaulting to 'string' content format`. Дальше `apply_chat_template` будет падать или вести себя непредсказуемо: рендерить нечем.

Отдельно от выбора шаблона `_run_template_detection` разбирает **`tokenizer.chat_template`** (не conv-шаблон!) и по нему выводит `force_reasoning`, `reasoning_config` и подсказки для `--reasoning-parser`/`--tool-call-parser`. Строка `Auto-detected template features: …` в логе относится именно к этому.

### Порядок разрешения, когда аргумент задан

`_load_explicit_chat_template` печатает `Loading chat template from argument: <value>` и дальше:

1. Значение есть в реестре `chat_templates` → это **встроенный conv-шаблон**, `chat_template_name = <value>`, файл не читается.
2. Значения нет в реестре и `os.path.exists(value)` ложно → `RuntimeError: Chat template <value> is not a built-in template name or a valid chat template file path.` — сервер не стартует. Это единственный случай, когда ошибка громкая.
3. Путь заканчивается на `.jinja` → файл читается целиком, подстановка `\n` из литерала в реальный перевод строки, результат кладется в `tokenizer.chat_template`, а `chat_template_name` **сбрасывается в `None`**. Лог: `Detected user specified Jinja chat template with content format: …`.
4. Иначе путь обязан быть `.json` (иначе `AssertionError: unrecognized format of chat template file`) — из него собирается `Conversation` и регистрируется с `override=True`, `chat_template_name = template["name"]`.

### Две ветки рендеринга

В `OpenAIServingChat._process_messages` (`sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`) развилка одна:

```python
elif self.template_manager.chat_template_name is None:
    result = self._apply_jinja_template(request, tools, is_multimodal)
else:
    result = self._apply_conversation_template(request, is_multimodal)
```

- **Jinja-ветка** (`chat_template_name is None`, то есть HF-шаблон или ваш `.jinja`): `tokenizer.apply_chat_template(..., add_generation_prompt=True, tools=tools, **extra_template_kwargs)`, поддерживаются `tools`, `chat_template_kwargs`, `reasoning_effort`, `continue_final_message`. При исключении делается вторая попытка с «плоским» списком функций (для Mistral-подобных шаблонов), а `jinja2.TemplateError`/`TypeError` превращаются в 400.
- **Conv-ветка** (сработали пункт 1 или 4 выше, либо угадывание по пути модели): `generate_chat_conv(request, name)` — жестко заданные `roles`, `sep_style`, `sep`, `stop_str`. **`tools` и `chat_template_kwargs` в промпт не попадают**, `enable_thinking` не работает, `reasoning_effort` игнорируется.

Именно поэтому «взять имя встроенного шаблона, потому что оно похоже на модель» — плохая идея для современной модели с tool calling и thinking: вы меняете не только разметку, но и набор поддерживаемых возможностей.

## Значения и формат

- **Имя встроенного шаблона.** Реестр наполняется при импорте `conversation.py`, поэтому список зависит от версии пакета. Посмотреть его на своей сборке:

  ```bash
  python -c "from sglang.srt.parser.conversation import chat_templates; print(sorted(chat_templates))"
  ```

  На checkout'е, по которому снят extract, там преимущественно мультимодальные и специализированные шаблоны (`chatml`, `llama-2`, `mistral`, `devstral`, `llama-4`, `gemma-it`, `vicuna_v1.1`, `qwen2-vl`, `internvl-2-5`, `minicpmv`, `whisper`, …). Универсального «возьми правильный для Qwen3/DeepSeek» имени там нет — для таких моделей правильный ответ это HF-шаблон, то есть **не задавать аргумент вообще**.
- **Путь к `.jinja`.** Обычный HF chat template. Проверяется только существование пути; синтаксис Jinja проверяется лениво — при первом запросе, и ошибка придет клиенту как 400, а не на старте.
- **Путь к `.json`.** Формат `conversation.py`: обязательные ключи `name`, `system`, `user`, `assistant`, `sep_style`, `stop_str`; необязательные `system_message`, `sep`. Неизвестный `sep_style` → `ValueError: Unknown separator style: <...>`. `system_template` собирается как `template["system"] + "\n{system_message}"`.
- **Inline-шаблон строкой не принимается.** Значение, которое не является ни зарегистрированным именем, ни существующим путем, всегда даёт `RuntimeError` на старте. Текст шаблона нужно положить в файл.
- Расширение файла значимо: `.jinja` → Jinja-ветка, любое другое → assert на `.json`.
- Пустая строка эквивалентна «не задан» (проверка `if chat_template_arg:` — falsy).

## Когда использовать

- Модель без `chat_template` в токенизаторе (голый base-чекпойнт, самосборный токенизатор): без аргумента вы получите `No chat template found` и нерабочий `/v1/chat/completions`. Даете `.jinja` — и ветка рендеринга остается нормальной.
- Нужно поправить служебную разметку (свой system prefix, свой формат tool-описаний) — берите **`.jinja`**, скопированный из модели и отредактированный: он сохраняет полноценный `apply_chat_template` со всеми kwargs.
- Мультимодальная модель, для которой апстрим уже написал conv-шаблон, а автоподбор по пути не сработал (свой каталог, переименованный чекпойнт) — имя встроенного шаблона тут уместно.
- **Не трогайте**, если модель нормальная HF-модель со своим `chat_template.jinja`. Для «выключить thinking» есть `--default-chat-template-kwargs`, для выбора одного из нескольких HF-шаблонов — `--hf-chat-template-name`; подмена шаблона целиком для этого не нужна и вредна.

## Влияние на производительность и память

На VRAM, KV-пул и CUDA graph не влияет: шаблон работает в процессе токенизатора и меняет только текст промпта. Косвенные эффекты два:

- Длина отрендеренного промпта меняет число prefill-токенов и, значит, нагрузку и стоимость запроса.
- Смена шаблона меняет префикс всех запросов, поэтому radix cache при перезапуске с новым шаблоном обнуляется по попаданиям — это разовая просадка hit rate, а не постоянная деградация.

## Взаимодействие с другими аргументами

- `--hf-chat-template-name`: работает **только** на шаге 2 автоподбора. Если `--chat-template` задан, именованный HF-шаблон не читается вообще.
- `--default-chat-template-kwargs`: kwargs подставляются в `request.chat_template_kwargs`, но доезжают до промпта только в Jinja-ветке. С встроенным conv-шаблоном они молча ничего не делают.
- `--reasoning-parser` / `--tool-call-parser`: автоподсказки для них выводятся из `tokenizer.chat_template`. Загрузив свой `.jinja` без `<think>`-разметки, вы заодно отключите автодетект reasoning.
- `--tokenizer-path`: HF-шаблон берется из токенизатора/процессора, то есть отсюда, а не из `--model-path`. Разъехавшиеся пути — отдельный источник «не тот шаблон».
- `--completion-template`: параллельный механизм для `/v1/completions` (FIM), общего кода с чат-шаблоном не имеет.
- `--served-model-name` на выбор шаблона не влияет: угадывание идет по `--model-path`.

В arriero инстанс SGLang виден прокси как обычный OpenAI-совместимый апстрим, и весь трафик Claude Code / OpenAI-клиентов идет через `/v1/chat/completions`, то есть ровно через эту ветку. Ошибка в шаблоне выглядит в arriero как «модель отвечает, но бессвязно» при полностью зеленом статусе инстанса (`docs/API_PROXY_FOUNDATION.md`), потому что уровень статусов измеряет процесс и HTTP, а не осмысленность вывода.

## Типовые проблемы и диагностика

- `RuntimeError: Chat template <x> is not a built-in template name or a valid chat template file path.` — опечатка в имени или относительный путь, которого нет относительно рабочего каталога процесса. Давайте абсолютный путь.
- `AssertionError: unrecognized format of chat template file` — файл существует, но расширение не `.jinja` и не `.json`.
- `ValueError: Unknown separator style: <...>` — в JSON-шаблоне значение `sep_style`, которого нет в перечислении `SeparatorStyle`.
- **Ответ грамматически связный, но модель не останавливается / повторяет роли / игнорирует system**: почти всегда рендеринг ушел в conv-ветку. Проверяется по логу старта — ищите `Inferred chat template from model path:` или `Loading chat template from argument:`. Если хотя бы одна из этих строк есть, `chat_template_name` не `None` и `apply_chat_template` не вызывается. Правильный ответ — снять `--chat-template` (или переименовать каталог модели так, чтобы не срабатывала матчинг-функция).
- **`tools` уходят в запрос, а модель их не видит**: та же conv-ветка — `_apply_conversation_template` не получает `tools` вовсе.
- `400` с текстом ошибки Jinja (`raise_exception` внутри шаблона, `tojson` на `Undefined`) — шаблон читается, но не принимает переданные сообщения/kwargs; это ошибка запроса, а не старта.
- Что подтверждает выбранный путь в логе: `Loading chat template from argument: …` (аргумент задан), `Inferred chat template from model path: …` (угадали по пути), `Using default HuggingFace chat template with detected content format: openai|string` (взяли HF), `No chat template found, defaulting to 'string' content format` (не нашли ничего), `Multiple HuggingFace chat templates available: [...]` + `Using first available template: '<name>'` (словарь шаблонов). Принятое значение самого аргумента видно в дампе `server_args=` при старте.
- Быстрая проверка результата без модели: отправьте запрос с `"max_tokens": 1` и `return_prompt_token_ids: true` на `/v1/chat/completions` (нестриминговый) и продетокенизируйте `prompt_token_ids` — увидите ровно то, что получила модель.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chat-template /models/templates/qwen3-custom.jinja --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/llava-onevision-qwen2-7b --chat-template chatml-llava --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/parser/template_manager.py`
- `sglang/python/sglang/srt/parser/conversation.py`
- `sglang/python/sglang/srt/parser/jinja_template_utils.py`
- `sglang/python/sglang/srt/parser/template_detection.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/references/custom_chat_template.mdx`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`
