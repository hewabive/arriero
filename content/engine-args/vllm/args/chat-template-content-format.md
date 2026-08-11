---
schema: 1
engine: vllm
primaryName: "--chat-template-content-format"
title: "--chat-template-content-format"
summary: В каком виде поле `content` сообщения попадает в Jinja-шаблон — плоской строкой или списком словарей OpenAI. По умолчанию форма угадывается разбором AST шаблона на каждый запрос.
group: Frontend
related:
  - --chat-template
  - --default-chat-template-kwargs
  - --allowed-local-media-path
  - --tokenizer-mode
---

# --chat-template-content-format

## Кратко

Аргумент решает, что увидит шаблон в `message['content']`: строку или список частей `[{"type": "text", ...}]`. Ошибка здесь не роняет сервер — она молча дает промпт, в котором пропали или задвоились плейсхолдеры изображений и аудио.

Значение `auto` (по умолчанию) означает не «оба формата», а «определить по шаблону»: vLLM компилирует Jinja-шаблон и ищет в AST цикл по `message['content']`.

## Оригинальная справка

```text
The format to render message content within a chat template.

* "string" will render the content as a string. Example: `"Hello World"`
* "openai" will render the content as a list of dictionaries, similar to
  OpenAI schema. Example: `[{"type": "text", "text": "Hello world!"}]`
```

## Паспорт аргумента

- Флаги: `--chat-template-content-format`
- Группа argparse: `Frontend`
- Тип значения: enum (строка)
- Допустимые значения: `auto`, `string`, `openai`
- Значение по умолчанию: `auto`
- Эффективное значение: при `auto` подставляется результат `_detect_content_format` — `openai`, если в AST шаблона найден цикл по `content`, иначе `string`; при неразбираемом шаблоне — `string`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.chat_template_content_format`
- Этап применения: HTTP-слой, разбор сообщений каждого чат-запроса перед применением шаблона

## Что меняет в движке

`resolve_chat_template_content_format` (`vllm/renderers/hf.py`) при значении, отличном от `auto`, немедленно возвращает заданный формат. При `auto` он сначала разрешает фактический шаблон (`resolve_chat_template`), затем компилирует его через `transformers` и обходит AST: наличие цикла вида `{% for part in message['content'] %}` трактуется как `openai`, отсутствие — как `string`. Результат кэшируется (`_detect_content_format`, `lru_cache(maxsize=32)`), а информационная строка лога печатается один раз на шаблон.

Дальше формат попадает в `parse_chat_messages` → `_parse_chat_message_content` (`vllm/entrypoints/chat_utils.py`) как `wrap_dicts = (content_format == "openai")`:

- `openai` — части сообщения остаются списком словарей, шаблон обязан сам их обойти;
- `string` — части склеиваются в один текст, а плейсхолдеры мультимодальных элементов (`<image>`, `<audio>` и т. п.) вставляются в этот текст функцией `_get_full_multimodal_text_prompt`.

Именно поэтому неверный формат портит именно мультимодальные запросы: при `string` шаблон, ожидающий список, получает строку и не выводит плейсхолдеры; при `openai` шаблон, ожидающий строку, печатает repr списка.

Рендерер Cohere (`vllm/renderers/cohere.py`) этот аргумент игнорирует и всегда разбирает сообщения как `openai`.

## Значения и формат

- `auto` — определить по шаблону. Каждый запрос проходит через `resolve_chat_template` (кэш AST спасает от повторной компиляции, но не от самого разрешения шаблона).
- `string` — принудительно плоский текст.
- `openai` — принудительно список словарей.
- Иных значений парсер не принимает: `choices` фиксированы, посторонняя строка отвергается argparse'ом с кодом 2.

## Когда использовать

- Задавайте явно, если в логе видно предупреждение о расхождении вашего значения с определенным, либо если модель мультимодальная и вы меняли `--chat-template`: автоопределение работает по одной эвристике (цикл по `content`) и на нестандартном шаблоне ошибается.
- Задавайте явно ради предсказуемости на нагруженном сервере: при `auto` разрешение формата выполняется в горячем пути каждого чат-запроса.
- Не трогайте на текстовой модели со штатным шаблоном: там оба формата дают одинаковый промпт, а `auto` вернет `string`.

## Влияние на производительность и память

VRAM и KV-cache не затрагивает напрямую. Влияет на CPU в процессе API-сервера: при `auto` на каждый чат-запрос вызывается разрешение шаблона, при явном значении эта ветка не выполняется вовсе. Косвенно влияет на длину промпта — неправильный формат может добавить или потерять плейсхолдеры и тем самым изменить число токенов.

## Взаимодействие с другими аргументами

- `--chat-template`: определение формата при `auto` идет по фактически выбранному шаблону, включая шаблон из запроса. Смена шаблона меняет определенный формат.
- `--default-chat-template-kwargs`: значения `tools` в kwargs участвуют в разрешении шаблона (см. приоритет `AutoProcessor` в `resolve_chat_template`), а значит косвенно влияют на автоопределение.
- `--allowed-local-media-path`: имеет смысл только для мультимодальных запросов — тех самых, где ошибка формата видна.
- `--tokenizer-mode`: в режиме `cohere` аргумент не применяется, разбор всегда `openai`.

## Типовые проблемы и диагностика

- **Симптом:** в логе `You specified --chat-template-content-format <X> which is different from the detected format '<Y>'`. **Причина:** ваше значение расходится с автоопределением. **Лечение:** убедиться, что шаблон действительно обходит `content`; если автоопределение неверно — оставить явное значение.
- **Симптом:** модель «не видит» картинку, хотя запрос принят. **Причина:** формат `openai` при шаблоне, который ожидает строку, — плейсхолдер изображения не попал в промпт. **Проверка:** запросить `POST /tokenize` с теми же сообщениями и посмотреть отрендеренный промпт. **Лечение:** `--chat-template-content-format string`.
- **Симптом:** в промпте видны фрагменты вида `[{'type': 'text', 'text': ...}]`. **Причина:** шаблон печатает `content` целиком, а формат — `openai`. **Лечение:** `--chat-template-content-format string` либо шаблон с обходом частей.
- **Симптом:** ошибка `Found more '<placeholder>' placeholders in input prompt than actual multi-modal data items`. **Причина:** плейсхолдеры уже были в тексте и добавились еще раз при склейке в режиме `string`. **Лечение:** убрать ручные плейсхолдеры из сообщений.
- **Подтверждение принятого значения:** строка лога `Detected the chat template content format to be '<...>'. You can set --chat-template-content-format to override this.` печатается один раз на шаблон.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --chat-template-content-format openai --allowed-local-media-path /srv/images
```

```bash
vllm serve /models/Qwen3-4B --chat-template /etc/vllm/qwen3-tools.jinja --chat-template-content-format string
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/renderers/hf.py`
- `vllm/vllm/renderers/cohere.py`
- `vllm/vllm/entrypoints/chat_utils.py`
