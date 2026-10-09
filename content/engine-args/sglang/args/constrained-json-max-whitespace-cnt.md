---
schema: 1
engine: sglang
primaryName: "--constrained-json-max-whitespace-cnt"
title: "--constrained-json-max-whitespace-cnt"
summary: Потолок длины серии пробельных символов в JSON, который генерируется под схему на backend'е xgrammar. Не задан — серии не ограничены. Нужен, когда модель «залипает» в пробелах и сжигает `max_tokens`, но компактный вывод не годится; на outlines и llguidance значение не передается.
group: serving
related:
  - --grammar-backend
  - --constrained-json-disable-any-whitespace
  - --constrained-json-whitespace-pattern
---

# --constrained-json-max-whitespace-cnt

## Кратко

При структурном выводе xgrammar по умолчанию разрешает между элементами JSON сколько угодно пробелов и переводов строк (`any_whitespace=True`). Модель пользуется этим для красивого форматирования, но иногда вырождается: генерирует бесконечную серию `\n` или пробелов внутри допустимой позиции и упирается в `max_tokens`, не закрыв объект.

Флаг сохраняет форматирование, но ограничивает каждую серию заданным числом символов. Это промежуточный вариант между полной свободой и `--constrained-json-disable-any-whitespace`. Аргумент новый (upstream PR #39026, вместе с повышением закрепленной версии xgrammar до 0.2.7); в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
(xgrammar backend only) Max consecutive whitespace chars allowed in JSON constrained output. None means unbounded.
```

## Паспорт аргумента

- Флаги: `--constrained-json-max-whitespace-cnt`
- Группа: `serving`
- Тип значения: int
- Допустимые значения: целое; SGLang диапазон не проверяет и передает число в xgrammar как есть
- Значение по умолчанию: `null` — серии не ограничены
- Эффективное значение: пайплайн разрешения поле не переписывает. Для применимости важно, что `--grammar-backend` при `null` становится `xgrammar` (`handle_grammar_backend` в `arg_groups/serving_hook.py`), поэтому на конфигурации по умолчанию флаг действует
- Где объявлен: `python/sglang/srt/arg_groups/fields/serving.py:Serving.constrained_json_max_whitespace_cnt`
- Статус: обычный, новый
- Этап применения: создание grammar backend (`create_grammar_backend`) в процессе планировщика → компиляция каждой новой JSON-схемы

## Что меняет в движке

`create_grammar_backend` (`constrained/base_grammar_backend.py`) передает значение в конструктор `XGrammarGrammarBackend` вместе с `any_whitespace`. В `XGrammarGrammarBackend.dispatch_json` оба уходят в компилятор:

```python
ctx = self.grammar_compiler.compile_json_schema(
    schema=key_string,
    any_whitespace=self.any_whitespace,
    max_whitespace_cnt=self.max_whitespace_cnt,
)
```

Ограничение действует на все, что приходит как JSON-схема:

- `response_format: {"type": "json_schema", ...}`;
- `response_format: {"type": "json_object"}` — OpenAI-слой (`entrypoints/openai/protocol.py`, `serving_completions.py`) превращает его в схему `{"type": "object"}`;
- ограничение вызова инструментов при `tool_choice: "required"` или именованной функции, когда парсер не дает structural tag и не разбирает `required` сам (`serving_chat.py` строит `("json_schema", ...)`);
- нативный `/generate` с `sampling_params.json_schema`.

Не действует:

- на специальный ключ `$$ANY$$` — он компилируется `compile_builtin_json_grammar()` без параметров пробелов;
- на `regex`, `ebnf` и `structural_tag`, включая structural tag у tool calling;
- на другие backend'ы: `OutlinesGrammarBackend` и `GuidanceBackend` параметр не получают, а `none` вообще не накладывает ограничений.

Значение одно на весь сервер; из запроса его не поменять.

## Значения и формат

- Не задан (`null`) — серии пробелов не ограничены, как до появления флага.
- `N` — не больше `N` подряд идущих пробельных символов там, где грамматика допускает пробелы. Как именно xgrammar считает серию (набор символов, позиции), определяет xgrammar, а не SGLang. Сверяйтесь с документацией той версии xgrammar, что стоит в окружении; в checkout закреплена `xgrammar==0.2.7` (`sglang/python/pyproject.toml`).
- `0` и отрицательные числа SGLang не отвергает; их смысл тоже определяет xgrammar. Для компактного JSON используйте `--constrained-json-disable-any-whitespace`, а не `0`.
- Вместе с `--constrained-json-disable-any-whitespace` лимит избыточен: необязательные пробелы и так запрещены.

## Когда использовать

- Структурный вывод или вызовы инструментов обрываются с `finish_reason: "length"`, а хвост ответа — сплошные пробелы или переводы строк.
- Отформатированный JSON нужен для чтения, но нужна и страховка от вырождения. Небольшое значение (upstream-тест `test_dp_attention.py` использует `4`) оставляет отступы и переносы, но не дает уйти в бесконечную серию.
- Не нужен, если уже задан `--constrained-json-disable-any-whitespace`.
- Бесполезен при `--grammar-backend outlines` или `llguidance`: там похожую задачу решает `--constrained-json-whitespace-pattern`, например `[ \n]{0,4}`.

## Влияние на производительность и память

- VRAM и KV-пул не затрагиваются.
- Компиляция грамматики идет один раз на схему и кешируется; влияние лимита на время компиляции не измерялось.
- Генерация: ограничен худший случай. Модель больше не может потратить весь `max_tokens` на пробелы, поэтому уменьшаются хвостовые задержки и занятость KV-пула вырожденными запросами.

## Взаимодействие с другими аргументами

- `--grammar-backend`: значение доходит только до `xgrammar` (дефолт). Если XGrammar не поддерживает токенизатор, backend тихо становится `none`, и ограничений нет вообще.
- `--constrained-json-disable-any-whitespace`: передается в тот же вызов как `any_whitespace=False`; вместе с ним лимит ничего не добавляет.
- `--constrained-json-whitespace-pattern`: аналог для outlines и llguidance; на xgrammar не читается.

## Типовые проблемы и диагностика

- **Флаг задан, а длинные серии пробелов остались.** Возможные причины: backend не `xgrammar` (поле `grammar_backend` в дампе `server_args=`); XGrammar не поддержал токенизатор и откатился в `none` (предупреждение `Grammar backend disabled because tokenizer is not supported by XGrammar`); запрос использует `$$ANY$$`, `regex`, `ebnf` или `structural_tag`.
- **`Hit invalid json_schema: key_string=…`.** Ошибка компиляции самой схемы, к лимиту отношения не имеет.
- **Проверка эффекта.** Отправьте одинаковый запрос до и после включения и сравните `completion_tokens` в `usage` и хвост ответа.
- **`unrecognized arguments: --constrained-json-max-whitespace-cnt`.** Установленная сборка старше PR #39026.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --constrained-json-max-whitespace-cnt 4
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --grammar-backend xgrammar --constrained-json-max-whitespace-cnt 2 --port 30000
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/srt/constrained/base_grammar_backend.py`
- `sglang/python/sglang/srt/constrained/xgrammar_backend.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/pyproject.toml`
- `sglang/test/registered/dp_attn/test_dp_attention.py`
- upstream PR #39026 «feat: use XGrammar V4.1 DSML parameter constraints» (коммит `ae7a516ba7` в checkout)
