---
schema: 1
engine: sglang
primaryName: "--constrained-json-whitespace-pattern"
title: "--constrained-json-whitespace-pattern"
summary: Регулярка, задающая, какие пробельные последовательности грамматика разрешает между элементами JSON при структурном выводе. Действует только на backend'ы outlines и llguidance — на дефолтном xgrammar значение игнорируется.
group: serving
related:
  - --constrained-json-disable-any-whitespace
  - --grammar-backend
---

# --constrained-json-whitespace-pattern

## Кратко

Тонкая настройка того же, чем грубо управляет `--constrained-json-disable-any-whitespace`: вместо «пробелы можно / нельзя» здесь задается регулярное выражение допустимого пробельного заполнения между синтаксическими элементами JSON.

Главное, что надо знать перед использованием: дефолтный grammar-backend SGLang — `xgrammar`, а он этот аргумент **не получает**. Без явного `--grammar-backend outlines` или `--grammar-backend llguidance` значение не делает ничего.

## Оригинальная справка

```text
(outlines and llguidance backends only) Regex pattern for syntactic whitespaces allowed in JSON constrained output. For example, to allow the model generate consecutive whitespaces, set the pattern to [
	 ]*
```

## Паспорт аргумента

- Флаги: `--constrained-json-whitespace-pattern`
- Группа: `serving`
- Тип значения: строка — регулярное выражение
- Допустимые значения: `choices` нет; синтаксис регулярки диктует выбранный backend (для `outlines` — `interegular`/`outlines.fsm`, для `llguidance` — его собственный движок)
- Значение по умолчанию: `null` — backend использует свой встроенный набор допустимых пробелов
- Эффективное значение: `__post_init__` не переопределяет
- Где объявлен: `ServerArgs.constrained_json_whitespace_pattern`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание grammar-backend при инициализации планировщика → компиляция грамматики под каждую новую JSON-схему

## Что меняет в движке

`create_grammar_backend` (`sglang/python/sglang/srt/constrained/base_grammar_backend.py`) передает значение ровно в двух ветках:

```python
if name == "outlines":
    grammar_backend = OutlinesGrammarBackend(
        tokenizer, whitespace_pattern=server_args.constrained_json_whitespace_pattern,
    )
...
elif name == "llguidance":
    grammar_backend = GuidanceBackend(
        tokenizer,
        any_whitespace=not server_args.constrained_json_disable_any_whitespace,
        whitespace_pattern=server_args.constrained_json_whitespace_pattern,
        n_vocab=vocab_size, eos_token_ids=eos_token_ids,
    )
```

- **outlines**: `OutlinesGrammarBackend.dispatch_json` строит из схемы регулярку — `build_regex_from_schema(schema, whitespace_pattern)` — и компилирует её в `RegexGuide`. То есть паттерн буквально подставляется в места пробельных заполнителей итогового регулярного выражения.
- **llguidance**: значение кладется в `defaults` вызова `LLMatcher.grammar_from_json_schema` под ключом `"whitespace_pattern"`, рядом с `"whitespace_flexible"`.
- **xgrammar** конструируется без этого параметра — только с `any_whitespace`.

Влияние ограничено путем JSON-схемы; `regex`, `ebnf` и `structural_tag` компилируются отдельно и паттерн не используют.

## Значения и формат

- Строка-регулярка. Пример из справки — `[\n\t ]*` (перевод строки, табуляция, пробел, ноль или больше раз): разрешает произвольные последовательности пробельных символов.
- В shell строку надо экранировать так, чтобы до Python дошли именно эти символы: одинарные кавычки плюс `$'...'` для управляющих последовательностей, либо буквальные перевод строки и табуляция внутри кавычек. Проще всего задавать паттерн без управляющих символов, например `' *'`.
- Пустая строка — валидное значение и означает «пробелов не допускается вовсе» (более жесткий вариант, чем `--constrained-json-disable-any-whitespace`).
- `null` (аргумент не задан) — у backend'а остается его собственный дефолт.
- Синтаксически некорректная регулярка на `outlines` даёт `interegular.patterns.InvalidSyntax` на первом запросе с JSON-схемой, а не на старте: запрос завершится ошибкой грамматики, сервер продолжит работать.

## Когда использовать

- Выбран `outlines` или `llguidance` (обычно из-за особенностей токенизатора или требований к совместимости), и нужно точнее контролировать форматирование JSON.
- Нужно разрешить именно многострочный отступ (например для читаемого вывода в UI) — тогда `[\n\t ]*`.
- Нужен максимально компактный вывод — пустой паттерн.
- **Не используйте** на xgrammar: там инструмент называется `--constrained-json-disable-any-whitespace`.
- **Не используйте** для форматирования ответа вообще: это ограничение грамматики, а не форматтер; postprocessing на стороне клиента дешевле и надежнее.

## Влияние на производительность и память

- VRAM и KV-пул не затрагиваются.
- Компиляция: у `outlines` паттерн попадает в итоговую регулярку и, при разрешающих квантификаторах, увеличивает FSM — это разовая стоимость на схему (грамматики кешируются по ключу).
- Генерация: чем свободнее паттерн, тем больше токенов модель может потратить на пробелы. Жесткий паттерн сокращает длину ответа.

## Взаимодействие с другими аргументами

- `--grammar-backend`: определяющий аргумент. `outlines` — паттерн действует; `llguidance` — действует вместе с `--constrained-json-disable-any-whitespace`; `xgrammar` (дефолт) — игнорируется; `none` — структурного вывода нет.
- `--constrained-json-disable-any-whitespace`: на `llguidance` оба значения уходят в один `defaults`, поэтому задавать их вместе осмысленно; на остальных backend'ах они не пересекаются, потому что действуют на разные из них.

## Типовые проблемы и диагностика

- **Значение задано, ничего не изменилось** — почти всегда работает дефолтный `xgrammar`. Проверьте `grammar_backend` в дампе `server_args=`.
- `Hit invalid json_schema: key_string=…` в логе с текстом про регулярку — на `outlines` паттерн вошел в итоговое выражение и сломал его компиляцию.
- **Ответ обрывается на середине JSON** — слишком свободный паттерн, модель тратит токены на пробелы; ужесточите паттерн или переключитесь на xgrammar с `--constrained-json-disable-any-whitespace`.
- **Экранирование съело символы** — сверьте фактически принятое значение в дампе `server_args=`: там видно, что реально дошло до процесса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grammar-backend outlines --constrained-json-whitespace-pattern ' *' --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grammar-backend llguidance --constrained-json-whitespace-pattern '' --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/constrained/base_grammar_backend.py`
- `sglang/python/sglang/srt/constrained/outlines_backend.py`
- `sglang/python/sglang/srt/constrained/llguidance_backend.py`
- `sglang/python/sglang/srt/constrained/xgrammar_backend.py`
