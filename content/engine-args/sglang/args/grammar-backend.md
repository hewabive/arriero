---
schema: 1
engine: sglang
primaryName: "--grammar-backend"
title: "--grammar-backend"
summary: Выбирает движок constrained decoding для `json_schema`, `regex`, `ebnf` и `structural_tag`. Backend определяет не скорость, а то, какие ограничения вообще выразимы: `outlines` не умеет EBNF и structural tag, `none` отключает structured output целиком, и в обоих случаях запрос завершается ошибкой, а не деградацией.
group: exec.kernel
related:
  - --constrained-json-whitespace-pattern
  - --constrained-json-disable-any-whitespace
  - --enable-strict-thinking
  - --reasoning-parser
  - --tool-call-parser
  - --sampling-backend
---

# --grammar-backend

## Кратко

`--grammar-backend` выбирает движок, который компилирует ограничение (JSON-схему, регулярку, EBNF-грамматику, structural tag) в маску разрешенных токенов и накладывает ее на логиты перед сэмплированием. Значение по умолчанию — `xgrammar`. Аргумент относится к корректности вывода: если выбранный backend не умеет выразить пришедшее ограничение, запрос не «выполняется без ограничения», а завершается с abort и текстом ошибки. Отдельно: `xgrammar` — единственный встроенный backend с поддержкой token filtering, без которого не работает `--enable-strict-thinking`.

## Оригинальная справка

```text
Choose the backend for grammar-guided decoding.
```

## Паспорт аргумента

- Флаги: `--grammar-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `xgrammar`, `outlines`, `llguidance`, `none`. Список — константа `GRAMMAR_BACKEND_CHOICES`, расширяемая функцией `add_grammar_backend_choices`; кроме того, `register_grammar_backend` (`sglang/python/sglang/srt/constrained/base_grammar_backend.py`) позволяет подменить любое имя своей реализацией — реестр `GRAMMAR_BACKEND_REGISTRY` проверяется раньше встроенных веток
- Значение по умолчанию: `null`
- Эффективное значение: `_handle_grammar_backend` в `__post_init__` подставляет `xgrammar`, если значение не задано. Второе переопределение происходит уже в рабочем процессе: если токенизатор модели не поддерживается XGrammar, backend молча становится `none` через `get_context().override("grammar.import_fallback", grammar_backend="none")`
- Где объявлен: `ServerArgs.grammar_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_grammar_backend` в `__post_init__` → `create_grammar_backend` при инициализации планировщика → компиляция грамматики на пул потоков при первом запросе с ограничением → применение маски словаря на каждом шаге декодирования

## Что меняет в движке

`create_grammar_backend` строит объект backend'а, `GrammarManager` (`sglang/python/sglang/srt/constrained/grammar_manager.py`) владеет им и кешем скомпилированных грамматик.

| backend | json_schema | regex | ebnf | structural_tag | token filtering |
| --- | --- | --- | --- | --- | --- |
| `xgrammar` | да | да | да | да (включая legacy-формат) | **да** |
| `outlines` | да (через компиляцию схемы в регулярку) | да | **нет** | **нет** | нет |
| `llguidance` | да | да | да | только legacy-формат (`is_legacy_structural_tag`) | нет |
| `none` | — | — | — | — | — |

Невыразимое ограничение проходит через `BaseGrammarBackend._not_supported`: в лог падает `Skip unsupported key_type='ebnf', key_string=…`, запрос получает `InvalidGrammarObject`, и `GrammarManager` завершает его через `set_finish_with_abort("Failed to compile ebnf grammar: …")`. То есть клиент получает ошибку, а не текст без ограничения — это важно, потому что «тихая деградация до свободной генерации» здесь не предусмотрена нигде.

`none` — не «backend без грамматики», а полное отсутствие: `create_grammar_backend` возвращает `None`, и любой запрос с `json_schema`/`regex`/`ebnf`/`structural_tag` немедленно завершается сообщением `Grammar-based generation (json_schema, regex, ebnf, structural_tag) is not supported when the server is launched with --grammar-backend none`.

Дополнительные обвязки:

- Если задан `--reasoning-parser` и у модели известны `think_end_ids`, выбранный backend заворачивается в `ReasonerGrammarBackend`: грамматика начинает применяться только после закрытия блока рассуждений.
- `--enable-strict-thinking` требует token filtering. С `--grammar-backend none` это `ValueError` на старте; с `outlines`/`llguidance` — `ValueError` из `ReasonerGrammarBackend` («Strict reasoning format requested but the grammar backend does not support token filtering»); если XGrammar не смог инициализироваться на этом токенизаторе, тихий откат на `none` заменяется явной ошибкой.
- `--constrained-json-whitespace-pattern` читают только `outlines` и `llguidance`; `--constrained-json-disable-any-whitespace` — только `xgrammar` и `llguidance`.

Компиляция грамматики асинхронна: она уходит в `ThreadPoolExecutor`, запрос ждет в `grammar_queue`, планировщик опрашивает его с интервалом `SGLANG_GRAMMAR_POLL_INTERVAL` (0.005 с) и после `SGLANG_GRAMMAR_MAX_POLL_ITERATIONS` (10000) итераций отменяет задачу с ошибкой `Grammar preprocessing timed out`. Скомпилированный результат кешируется по ключу `(тип, строка)`, включая отрицательный результат.

## Значения и формат

- `xgrammar` — дефолт и единственный вариант с полным покрытием и token filtering.
- `outlines` — исторический backend; EBNF и structural tag он не поддерживает вовсе, JSON-схема компилируется в регулярное выражение, поэтому часть схем отклоняется с `NotImplementedError` в `build_regex_from_object`.
- `llguidance` — поддерживает EBNF (Lark-синтаксис) и только legacy-форму structural tag; новый формат уйдет в `_not_supported`.
- `none` — осознанное отключение structured output. Имеет смысл, только если вы точно знаете, что клиенты его не используют, и хотите убрать зависимость и накладные расходы.
- Значение вне `choices` отвергает argparse; имя, зарегистрированное через `register_grammar_backend`, argparse пропустит только если оно попало и в `GRAMMAR_BACKEND_CHOICES`.

## Когда использовать

- Оставляйте `xgrammar`, пока нет конкретной причины: он покрывает весь набор ограничений и требуется для строгого режима рассуждений.
- Переключайтесь на `llguidance`, если у вас грамматики в Lark-синтаксисе или вы уперлись в конкретный баг компиляции XGrammar.
- `outlines` — только для совместимости со старой конфигурацией; на новых схемах он ограничивает вас сильнее остальных.
- `none` — когда structured output заведомо не нужен и вы хотите, чтобы такие запросы отклонялись явно, а не тратили CPU на компиляцию.

## Влияние на производительность и память

- VRAM: маска словаря битовая (`allocate_vocab_mask` у XGrammar — это `_allocate_token_bitmask(vocab_size, batch_size)`), то есть примерно `batch × vocab / 8` байт; она строится на CPU и копируется на устройство перед применением. На фоне KV-пула это шум.
- RAM и CPU: компиляция грамматики идет на CPU в пуле потоков планировщика. Сложная JSON-схема компилируется десятки-сотни миллисекунд и в это время занимает поток; кеш снимает стоимость для повторных одинаковых схем.
- Latency: первый запрос с новой схемой ждет компиляции в `grammar_queue` (не блокируя другие запросы). Дальше на каждом шаге добавляется применение маски — у `xgrammar` это ядро `apply_vocab_mask` на GPU, у `outlines` — CPU-обход автомата.
- Время старта: `none` убирает импорт соответствующего пакета; остальные backend'ы инициализируют компилятор при старте планировщика.

## Взаимодействие с другими аргументами

- `--enable-strict-thinking`: требует backend с token filtering, то есть фактически `xgrammar`.
- `--reasoning-parser`: включает обертку `ReasonerGrammarBackend` над любым выбранным backend'ом.
- `--constrained-json-whitespace-pattern`: только `outlines` и `llguidance`.
- `--constrained-json-disable-any-whitespace`: только `xgrammar` и `llguidance`.
- `--tool-call-parser`: сам по себе грамматику не включает, но клиентские схемы инструментов обычно приходят как `json_schema` и упираются в этот backend.
- `--sampling-backend`: маска применяется до сэмплирования и не зависит от него.

## Типовые проблемы и диагностика

- **Симптом:** запрос с `ebnf` завершается ошибкой `Failed to compile ebnf grammar: …`. **Причина:** backend `outlines`. **Решение:** `--grammar-backend xgrammar`.
- **Симптом:** все structured-запросы отклоняются с упоминанием `--grammar-backend none`, хотя вы его не задавали. **Причина:** XGrammar не смог построить `TokenizerInfo`. **Проверка:** warning `Grammar backend disabled because tokenizer is not supported by XGrammar: … Falling back to grammar_backend='none'.` **Решение:** `llguidance` либо другой токенизатор.
- **Симптом:** `ValueError: --enable-strict-thinking requires a grammar backend with token filtering support`. **Решение:** `xgrammar`.
- **Симптом:** запросы висят и завершаются с `Grammar preprocessing timed out`. **Причина:** слишком тяжелая схема или перегруженный CPU планировщика.
- **Симптом:** `Skip unsupported key_type='structural_tag'` в логе. **Причина:** новый формат structural tag на `llguidance` или `outlines`.
- **Проверка:** дамп `server_args=` при старте показывает разрешенное значение; строка про fallback появляется отдельно, уже при инициализации планировщика.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grammar-backend xgrammar --constrained-json-disable-any-whitespace
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grammar-backend llguidance --constrained-json-whitespace-pattern "[\n\t ]*"
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/constrained/base_grammar_backend.py`
- `sglang/python/sglang/srt/constrained/grammar_manager.py`
- `sglang/python/sglang/srt/constrained/xgrammar_backend.py`
- `sglang/python/sglang/srt/constrained/outlines_backend.py`
- `sglang/python/sglang/srt/constrained/llguidance_backend.py`
- `sglang/python/sglang/srt/constrained/reasoner_grammar_backend.py`
- `sglang/python/sglang/srt/environ.py`
