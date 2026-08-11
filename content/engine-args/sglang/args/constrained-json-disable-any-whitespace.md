---
schema: 1
engine: sglang
primaryName: "--constrained-json-disable-any-whitespace"
title: "--constrained-json-disable-any-whitespace"
summary: Запрещает произвольные пробелы в JSON, генерируемом под схемой: грамматика допускает только компактное представление. Действует на backend'ы xgrammar и llguidance; на outlines не влияет.
group: serving
related:
  - --constrained-json-whitespace-pattern
  - --grammar-backend
  - --enable-strict-thinking
---

# --constrained-json-disable-any-whitespace

## Кратко

При структурном выводе (`response_format: json_schema`, `json_object`, поле `json_schema` в нативном запросе) грамматика по умолчанию разрешает модели вставлять пробелы и переводы строк между токенами JSON — как в «красивом» форматировании. Это дает модели свободу тратить токены на отступы и, что хуже, уходить в длинные серии пробелов.

Флаг убирает эту свободу: допускается только компактная форма.

## Оригинальная справка

```text
(xgrammar and llguidance backends only) Enforce compact representation in JSON constrained output.
```

## Паспорт аргумента

- Флаги: `--constrained-json-disable-any-whitespace`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false` — произвольные пробелы разрешены
- Эффективное значение: `__post_init__` не переопределяет; значение передается в backend инвертированным (`any_whitespace = not флаг`)
- Где объявлен: `ServerArgs.constrained_json_disable_any_whitespace`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание grammar-backend при инициализации планировщика → компиляция грамматики под каждую новую JSON-схему

## Что меняет в движке

`create_grammar_backend` (`sglang/python/sglang/srt/constrained/base_grammar_backend.py`) прокидывает инвертированное значение:

```python
grammar_backend = XGrammarGrammarBackend(
    tokenizer, vocab_size=vocab_size, model_eos_token_ids=eos_list,
    any_whitespace=not server_args.constrained_json_disable_any_whitespace,
)
```

и аналогично в `GuidanceBackend(any_whitespace=..., whitespace_pattern=...)`.

Дальше:

- **xgrammar** — `XGrammarGrammarBackend.dispatch_json` вызывает `self.grammar_compiler.compile_json_schema(schema=key_string, any_whitespace=self.any_whitespace)`. Важная деталь: особый ключ `$$ANY$$` (произвольный валидный JSON, используется когда схемы нет) идет через `compile_builtin_json_grammar()` **без** этого параметра, то есть на него флаг не действует.
- **llguidance** — `GuidanceBackend.dispatch_json` кладет значение в `defaults` как `"whitespace_flexible": self.any_whitespace` вместе с `"whitespace_pattern"`.
- **outlines** — `OutlinesGrammarBackend` конструируется только с `whitespace_pattern`; этот флаг до него не доходит вовсе.

Ни на `regex`, ни на `ebnf`, ни на `structural_tag` флаг не влияет — только на путь JSON-схемы.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — эквивалент `any_whitespace=True`: модель вольна форматировать JSON как угодно, оставаясь валидной по схеме.
- Задан — компактная форма без необязательных пробелов.
- Промежуточных вариантов нет; тонкая настройка допустимых пробелов — это `--constrained-json-whitespace-pattern`, и она работает на других backend'ах.

## Когда использовать

- Модель, генерируя JSON по схеме, уходит в длинные серии пробелов/переводов строк и «прожигает» `max_tokens` до закрывающей скобки. Это самый частый рабочий повод.
- Нужен предсказуемый и минимальный расход токенов на структурированный вывод (агенты, извлечение данных, батч-обработка).
- **Не включайте**, если человек читает сырой ответ и от него ждут отформатированного JSON: клиент всё равно может отформатировать сам, но об этом надо помнить.
- **Бесполезен** при `--grammar-backend outlines`: значение туда не передается.

## Влияние на производительность и память

- VRAM и KV-пул не затрагиваются.
- Компиляция грамматики: компактный вариант обычно чуть проще, но разница на фоне общей компиляции схемы незначительна. Грамматики кешируются по ключу схемы, так что стоимость платится один раз на схему.
- Генерация: главный эффект — меньше сгенерированных токенов на тот же JSON. На больших объектах это заметное сокращение времени ответа и занятости KV-пула.

## Взаимодействие с другими аргументами

- `--grammar-backend`: определяет, дойдет ли значение до backend'а. `xgrammar` (дефолт) и `llguidance` — да; `outlines` — нет; `none` — структурного вывода вообще нет.
- `--constrained-json-whitespace-pattern`: парный аргумент для `outlines` и `llguidance`. На `llguidance` действуют оба одновременно (`whitespace_flexible` и `whitespace_pattern` идут в один `defaults`); на xgrammar — только этот флаг, на outlines — только тот.
- `--enable-strict-thinking`: тоже опирается на xgrammar, но фильтрует фазу размышления; на JSON-грамматику не влияет.

## Типовые проблемы и диагностика

- **Флаг задан, а пробелы остались** — три причины: выбран `outlines`; запрос идет через `json_object`/`$$ANY$$` без явной схемы (xgrammar компилирует встроенную грамматику без этого параметра); или JSON генерируется вообще без структурного ограничения (модель просто «пишет JSON текстом»).
- `Hit invalid json_schema: key_string=…` в логе — ошибка компиляции самой схемы, к пробелам отношения не имеет; запрос получит `InvalidGrammarObject` и завершится с ошибкой грамматики.
- **Ответ обрывается на середине JSON** — упёрлись в `max_tokens`; включение флага как раз и уменьшает вероятность этого.
- Проверка: два одинаковых запроса с одной схемой, с флагом и без, — сравните `completion_tokens` в `usage`.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --constrained-json-disable-any-whitespace --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grammar-backend llguidance --constrained-json-disable-any-whitespace --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/constrained/base_grammar_backend.py`
- `sglang/python/sglang/srt/constrained/xgrammar_backend.py`
- `sglang/python/sglang/srt/constrained/llguidance_backend.py`
- `sglang/python/sglang/srt/constrained/outlines_backend.py`
