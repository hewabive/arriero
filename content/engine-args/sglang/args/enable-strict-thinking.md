---
schema: 1
engine: sglang
primaryName: "--enable-strict-thinking"
title: "--enable-strict-thinking"
summary: Во время фазы размышления маскирует токены, которых там быть не должно (маркеры tool call, EOS), и позволяет ограничить длину thinking через `max_thinking_tokens`. Требует `--reasoning-parser` и grammar-backend с поддержкой фильтра токенов (сегодня это только xgrammar).
group: serving
related:
  - --reasoning-parser
  - --grammar-backend
  - --tool-call-parser
  - --default-chat-template-kwargs
  - --strip-thinking-cache
  - --constrained-json-disable-any-whitespace
---

# --enable-strict-thinking

## Кратко

Reasoning-модель внутри `<think>…</think>` иногда «срывается»: выдает открывающий `<tool_call>`, EOS или маркер конца сообщения посреди размышления. Дальше парсер видит структуру, которой быть не должно, и запрос деградирует.

Флаг подключает жесткую фильтрацию словаря на время размышления: список запрещенных токенов берется из reasoning-парсера модели и маскируется в logits. Дополнительно появляется бюджет размышления — серверный (`SGLANG_MAX_THINK_TOKENS`) и пер-запросный (`max_thinking_tokens`); при его исчерпании модель **принуждается** выдать следующий токен закрывающей последовательности `</think>`.

Флаг встраивается в машинерию constrained decoding, поэтому у него жесткие требования к grammar-backend'у, а нарушение этих требований — ошибка старта, а не тихая деградация.

## Оригинальная справка

```text
Enable strict token filtering during the thinking phase. Blocks model-specific excluded tokens (e.g., tool call markers) during reasoning. Requires a grammar backend that supports token filtering.
```

## Паспорт аргумента

- Флаги: `--enable-strict-thinking`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет, но `create_grammar_backend` при несовместимом backend'е не деградирует, а бросает исключение
- Где объявлен: `ServerArgs.enable_strict_thinking`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание grammar-backend при инициализации планировщика → подготовка grammar-объекта для каждого запроса → маскирование словаря на каждом шаге декодирования

## Что меняет в движке

### Требования на старте

`create_grammar_backend` (`sglang/python/sglang/srt/constrained/base_grammar_backend.py`) содержит два жестких гейта:

- `--grammar-backend none` → `ValueError: --enable-strict-thinking requires a grammar backend that supports token filtering, but grammar_backend='none' was specified. Use --grammar-backend xgrammar or another backend that supports token filtering.`
- xgrammar не смог инициализироваться на данном токенизаторе (`TokenizerNotSupportedError`) → вместо обычного отката на `grammar_backend='none'` бросается `ValueError` с текстом «Cannot fall back to grammar_backend='none' with strict thinking enabled».

Поддержка фильтра объявляется свойством `is_support_token_filter`; в базовом классе оно `False`, `True` его возвращает только `XGrammarGrammarBackend`. Дефолтный backend и так xgrammar (`_handle_grammar_backend` подставляет его при `None`), так что специально указывать `--grammar-backend` обычно не нужно.

### Что именно фильтруется

`ReasonerGrammarBackend` создается только если задан `--reasoning-parser` **и** закрывающий токен размышления кодируется токенизатором. Список запрещенных токенов берется из детектора парсера:

```python
if (not self.enable_strict_thinking) or (not reasoning_parser.detector.think_excluded_tokens):
    return None
```

Наборы `think_excluded_tokens` зашиты в конкретные детекторы (`sglang/python/sglang/srt/parser/reasoning_parser.py`) и различаются по моделям: для Qwen-семейства это `<tool_call>`, `</tool_call>`, `<|im_end|>`, `<|endoftext|>`; для Kimi — набор `<|tool_call*|>`, `[EOS]`, `[EOT]` и др.; у части парсеров списка нет вовсе. Если `think_excluded_tokens` у выбранного парсера пуст и `SGLANG_MAX_THINK_TOKENS` равен `-1`, то `enable_token_filter` остается `False` и фильтровать нечего:

```python
self.enable_token_filter = self.enable_strict_thinking and (
    self.think_excluded_token_ids is not None or self.max_think_tokens >= 0
)
```

Если фильтр всё же нужен, а backend его не поддерживает — `ValueError: Strict reasoning format requested but the grammar backend does not support token filtering.`

### Как это работает на каждом шаге

`ReasonerGrammarObject.fill_vocab_mask` (`sglang/python/sglang/srt/constrained/reasoner_grammar_backend.py`):

- пока идет размышление и бюджет не исчерпан — запрещенные токены маскируются (`is_allowed=False`);
- когда бюджет исчерпан (`_can_think_more()` ложно) — маска разворачивается наоборот: **разрешен ровно один** токен, очередной элемент последовательности `</think>`, то есть модель принудительно закрывает размышление;
- после закрытия размышления управление переходит к внутренней грамматике (json_schema/regex/ebnf), если она была.

Важное следствие для производительности: `GrammarManager.process_req_with_grammar` при включенном флаге создает grammar-объект даже для запросов **без** структурных ограничений (ветка `elif self._enable_strict_thinking: init_strict_reasoning_grammar(...)`). То есть маска словаря начинает выделяться и применяться на всех reasoning-запросах, а не только на constrained.

### Пер-запросный бюджет

`GenerateReqInput.max_thinking_tokens` попадает в `sampling_params.custom_params["thinking_budget"]` и оттуда в `ReasonerGrammarObject.max_think_tokens`. Без этого флага сервер отказывает сразу:

```python
raise ValueError("max_thinking_tokens requires the server to be launched with --enable-strict-thinking")
```

Серверный дефолт бюджета — переменная окружения `SGLANG_MAX_THINK_TOKENS` (по умолчанию `-1`, то есть без ограничения); CLI-аргумента у нее нет.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — фильтрации нет, `max_thinking_tokens` в запросе отвергается.
- Величина бюджета задается **не этим флагом**, а `SGLANG_MAX_THINK_TOKENS` (сервер целиком) или полем `max_thinking_tokens` в теле запроса к `/generate`.
- `SGLANG_MAX_THINK_TOKENS = -1` — без ограничения; `0` и больше — жесткий потолок в токенах размышления.

## Когда использовать

- Reasoning-модель с tool calling, и в логах/ответах встречаются оборванные или вложенные tool call'ы, начатые внутри размышления. Это ровно тот случай, ради которого флаг написан.
- Нужен потолок на длину размышления (латентность, стоимость): `--enable-strict-thinking` плюс `max_thinking_tokens` в запросах.
- **Не включайте** без `--reasoning-parser` — `ReasonerGrammarBackend` не будет создан, и флаг останется только набором гейтов на старте.
- **Не включайте**, если у выбранного парсера нет `think_excluded_tokens` и бюджет не используется: получите накладные расходы на маску словаря без единого эффекта.
- **Не используйте** как способ выключить размышление целиком — это `--default-chat-template-kwargs '{"enable_thinking": false}'`.

## Влияние на производительность и память

- **VRAM**: битовая маска словаря (`allocate_vocab_mask`) на каждый запрос в батче — величина порядка `vocab_size / 8` байт на запрос. Для 150k-словаря это ~19 КБ на запрос; на фоне KV мелочь, но при флаге она выделяется и для запросов без грамматики.
- **CPU/latency декодирования**: заполнение и применение маски добавляется к каждому шагу reasoning-фазы. На большом батче это заметная, хотя и не доминирующая, добавка.
- **KV-пул**: напрямую не затрагивается. Косвенно — ограничение бюджета размышления укорачивает генерацию и освобождает пул раньше.
- Время старта не меняется.

## Взаимодействие с другими аргументами

- `--reasoning-parser`: без него `ReasonerGrammarBackend` не создается и фильтровать нечего. Он же определяет и `</think>`, и список запрещенных токенов.
- `--grammar-backend`: `none` — ошибка старта; `outlines` и `llguidance` не объявляют `is_support_token_filter`, поэтому при непустом фильтре тоже дадут ошибку. Рабочее значение — `xgrammar` (он же дефолт).
- `--tool-call-parser`: сам по себе фильтрацию не включает, но именно его маркеры чаще всего и блокируются в фазе размышления.
- `--strip-thinking-cache`: соседняя настройка про reasoning, но про KV после генерации; механизмы независимы и комбинируются свободно.
- `--constrained-json-disable-any-whitespace` / `--constrained-json-whitespace-pattern`: настройки того же grammar-backend'а; на фильтрацию thinking не влияют.

## Типовые проблемы и диагностика

- `ValueError: --enable-strict-thinking requires a grammar backend that supports token filtering, but grammar_backend='none' was specified.` — уберите `--grammar-backend none` или флаг.
- `ValueError: --enable-strict-thinking requires a grammar backend with token filtering support, but XGrammar failed to initialize: …` — токенизатор модели не поддерживается xgrammar. Без флага сервер бы просто отключил структурный вывод, с флагом — не стартует.
- `ValueError: Strict reasoning format requested but the grammar backend does not support token filtering. Use a grammar backend that supports token filtering (e.g., xgrammar) or disable strict reasoning mode.` — backend выбран не xgrammar, а фильтр требуется.
- `ValueError: think_end_token '<...>' could not be encoded by the tokenizer.` / аналогичное про `think_excluded_token` — парсер и токенизатор не соответствуют друг другу; проверьте, тот ли `--reasoning-parser` выбран для этой модели.
- `ValueError: max_thinking_tokens requires the server to be launched with --enable-strict-thinking` — клиент прислал бюджет на сервер без флага.
- **Флаг включен, tool call'ы всё равно появляются внутри размышления** — у выбранного парсера пустой `think_excluded_tokens`. Проверяется чтением соответствующего детектора в `reasoning_parser.py`.
- **Размышление обрывается ровно на N токенах** — сработал бюджет: маска разрешила только очередной токен `</think>`. Это штатное поведение, а не сбой генерации.
- Принятое значение флага — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --reasoning-parser qwen3 --tool-call-parser qwen25 --enable-strict-thinking --port 30000
```

```bash
SGLANG_MAX_THINK_TOKENS=2048 python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --reasoning-parser qwen3 --enable-strict-thinking --grammar-backend xgrammar --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/constrained/base_grammar_backend.py`
- `sglang/python/sglang/srt/constrained/reasoner_grammar_backend.py`
- `sglang/python/sglang/srt/constrained/grammar_manager.py`
- `sglang/python/sglang/srt/constrained/xgrammar_backend.py`
- `sglang/python/sglang/srt/parser/reasoning_parser.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/environ.py`
