---
schema: 1
engine: sglang
primaryName: "--reasoning-parser"
title: "--reasoning-parser"
summary: Выбирает детектор, который вырезает блок рассуждения из ответа и кладет его в `reasoning_content`. Список значений собирается из реестра детекторов в момент построения парсера аргументов; `auto` определяет детектор по chat template модели.
group: null
related:
  - --tool-call-parser
  - --chat-template
  - --default-chat-template-kwargs
  - --enable-strict-thinking
  - --strip-thinking-cache
  - --served-model-name
  - --grammar-backend
---

# --reasoning-parser

## Кратко

Модель-рассуждатель печатает мысли и ответ одним потоком токенов, разделяя их служебными тегами (`<think>…</think>` и родственные). `--reasoning-parser` включает детектор, который на HTTP-слое разрезает этот поток и возвращает мысли отдельным полем `reasoning_content`, а ответ — в `content`. Ошибка в выборе детектора не приводит к отказу: сервер поднимется и будет отдавать 200, но ответы окажутся структурно неправильными — либо теги останутся внутри `content`, либо, наоборот, весь ответ уедет в `reasoning_content`, а `content` будет пустым.

Аргумент трогает только HTTP-слой. Ни генерацию, ни KV-кеш, ни планировщик он не меняет.

## Оригинальная справка

```text
Specify the parser for reasoning models. Use 'auto' to detect from chat template. Options include: {reasoning_parser_choices}.
```

Фигурные скобки в тексте — это не литерал: `help` собирается f-строкой, и в реальном `--help` на их месте стоит список ключей реестра. В extract попала форма до подстановки, потому что declaration extract читает исходник, а не запущенный argparse.

## Паспорт аргумента

- Флаги: `--reasoning-parser`
- Группа: `null` — поле `ServerArgs.reasoning_parser` объявлено без `Arg(...)`, поэтому авто-регистрация его пропускает, а флаг заводится литеральным `parser.add_argument` в `add_cli_args` (случай «динамические choices»)
- Тип значения: str
- Допустимые значения: `choices` в extract равны `null`, но argparse ограничение накладывает: `["auto"] + list(ReasoningParser.DetectorMap.keys())`. Список собирается из реестра детекторов (`sglang/python/sglang/srt/parser/reasoning_parser.py`) в момент вызова `add_cli_args`, поэтому зависит от версии пакета и статически не фиксируется. Настоящий список своей сборки смотрите так: `python -m sglang.launch_server --help | grep -A4 -- --reasoning-parser` либо `python -c "from sglang.srt.parser.reasoning_parser import ReasoningParser; print(sorted(ReasoningParser.DetectorMap))"`
- Значение по умолчанию: `ServerArgs.reasoning_parser`, то есть `None` — разделение рассуждения выключено
- Эффективное значение: при `auto` подменяется на имя детектора, определенное по chat template (`resolve_auto_parsers`), либо на `None`, если определить не удалось
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `resolve_auto_parsers` в `Engine` до запуска процессов (при `auto`) → повторная попытка по chat template в `_launch_tokenizer_manager_process` → конструирование детектора в `OpenAIServingChat.__init__` → разбор каждого ответа

## Что меняет в движке

### Резолюция `auto`

`auto` разрешается дважды и в разных местах:

1. `resolve_auto_parsers` (`sglang/python/sglang/srt/parser/template_detection.py`) вызывается из `Engine` до форка планировщиков. Он подгружает токенизатор, берет `tokenizer.chat_template` (или явный Jinja-шаблон из `--chat-template`) и прогоняет его через правила `REASONING_PARSER_RULES`. Если шаблон прочитать не удалось, включается запасной путь по архитектуре модели (`_architecture_auto_parsers`).
2. Если значение все еще `auto`, после инициализации `TemplateManager` берется его `suggested_reasoning_parser`.

Итог печатается в лог:

```text
Auto-detected --reasoning-parser as 'qwen3' from chat template
```

или, при неудаче:

```text
--reasoning-parser=auto specified but could not detect reasoning parser from chat template. Disabling reasoning parser.
```

Во втором случае значение становится `None`, то есть разделение просто выключается — старт не падает.

### Разбор ответа

`OpenAIServingChat` создает `ReasoningParser(model_type=<значение>)`; `DetectorMap` отдает класс детектора, у каждого свои `think_start_token` / `think_end_token` и флаг `force_reasoning`. Разделение выполняется, только если в запросе `separate_reasoning` истинно (значение по умолчанию — `true` в схеме `ChatCompletionRequest`).

Ключевой факт про поведение при рассинхроне: если детектор считает, что находится внутри блока рассуждения (`force_reasoning=True` либо во входе встретился стартовый тег), а закрывающего тега в тексте нет, `_detect_and_parse_impl` возвращает **весь текст как `reasoning_text`** («Assume reasoning was truncated before end token») и пустой `content`. Детекторы с принудительным режимом — `qwen3-thinking`, `gpt-oss`, `minimax`, — поэтому особенно опасны на чужой модели.

Обратная ошибка мягче: если детектор ждет теги, которых модель не печатает, и стартовый тег не встретился, текст целиком уходит в `content` — то есть теги другой модели остаются в ответе как обычный текст.

## Значения и формат

- Одно строковое значение из реестра либо `auto`. Опечатка отвергается argparse'ом на старте: `error: argument --reasoning-parser: invalid choice: 'qwen-3' (choose from 'auto', 'apertus2509', …)`.
- Не задавать — значит выключить: `reasoning_content` не появится, а теги останутся в `content`.
- Ключи реестра — не имена моделей, а имена форматов, и один детектор обслуживает несколько семейств (например, `step3`/`step3p5`/`deepseek-r1` — один и тот же класс). Значение подбирается по формату тегов, а не по названию модели.
- Часть детекторов ведет себя по-разному в зависимости от `chat_template_kwargs` запроса (`thinking_mode`, `force_nonempty_content`); это уровень запроса, а не сервера, но `--default-chat-template-kwargs` позволяет задать значения по умолчанию.

## Когда использовать

- Обслуживание рассуждающей модели через OpenAI-совместимый чат, когда клиенту нужен отдельный `reasoning_content` (например, чтобы не показывать мысли пользователю и не отправлять их обратно в историю).
- Задавать явно, если модель локальная и chat template переопределен своим файлом: авто-определение читает именно шаблон, и подмена шаблона легко ломает детекцию.
- Не включать «на всякий случай» для модели без рассуждения: детектор с принудительным режимом опустошит `content`.
- В arriero: значение видно клиенту прокси в поле ответа, но сам прокси его не интерпретирует — узел `reasoning` в pipeline (`docs/API_PROXY_PIPELINES.md`) работает со своей нормализацией и не заменяет серверный парсер.

## Влияние на производительность и память

На VRAM, KV-пул и время старта не влияет, кроме одной детали: при `auto` на старте дополнительно загружается токенизатор для чтения chat template — это единицы секунд и десятки мегабайт RAM в процессе `Engine`. На горячем пути детектор — это построчный разбор строки в процессе токенизатор-менеджера; в потоковом режиме на каждый чанк вызывается `parse_stream_chunk`, стоимость измеряется микросекундами на чанк.

## Взаимодействие с другими аргументами

- `--tool-call-parser`: независимая ручка, разрешается тем же механизмом `auto` и в том же месте. Порядок разбора в ответе — сначала рассуждение, потом tool call.
- `--chat-template`: при `auto` определяет результат. Явный шаблон, который не читается как Jinja, отключает авто-детекцию с предупреждением `--chat-template=… is explicit but is not a readable Jinja template …`.
- `--default-chat-template-kwargs`: задает значения по умолчанию для ключей вроде `thinking_mode`, от которых зависят некоторые детекторы.
- `--enable-strict-thinking`: фильтрация токенов на фазе рассуждения; требует grammar backend с поддержкой фильтра и осмысленна только вместе с заданным парсером.
- `--strip-thinking-cache`: определяет, попадет ли текст рассуждения в radix-кеш; ортогонален выбору детектора, но обычно включается вместе с ним.
- `--grammar-backend`: при заданном парсере часть путей structured output обрабатывается иначе (в `serving_chat.py` есть ветка `xgrammar_reasoning`, активная только когда парсер **не** задан).

## Типовые проблемы и диагностика

- `content` пустой, весь ответ в `reasoning_content` — детектор в принудительном режиме не нашел закрывающий тег. Проверьте, тот ли формат выбран; сравните сырой вывод модели (`/v1/completions` без парсера) с ожидаемыми тегами детектора.
- Теги `<think>` видны в `content` — парсер не задан либо задан детектор с другими тегами.
- `--reasoning-parser=auto` не сработал — ищите в логе строку `could not detect reasoning parser from chat template`. Это не ошибка, а сообщение о том, что функция выключена; задайте значение явно.
- `Failed to initialize reasoning detector for parser '<x>': …` — предупреждение из `OpenAIServingChat.__init__`; парсер остался, но детектор не построился.
- `error: argument --reasoning-parser: invalid choice: …` — опечатка либо значение из другой версии пакета. Сверьтесь с `--help` установленной сборки: реестр отличается между релизами, и это ровно тот класс расхождений, что описан в `docs/CASE_PHANTOM_HELP_ARGS.md`.
- Что смотреть в логе и по API: `Auto-detected --reasoning-parser as '<x>' from chat template`, дамп `server_args=` при старте, `GET /server_info` (там уже разрешенное значение, а не исходное `auto`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --reasoning-parser qwen3
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1 --reasoning-parser auto --tool-call-parser auto --chat-template /etc/sglang/deepseek-r1.jinja
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/parser/reasoning_parser.py`
- `sglang/python/sglang/srt/parser/template_detection.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/docs/docs/advanced_features/separate_reasoning.mdx`
- arriero: `docs/CASE_PHANTOM_HELP_ARGS.md`, `docs/API_PROXY_PIPELINES.md`
