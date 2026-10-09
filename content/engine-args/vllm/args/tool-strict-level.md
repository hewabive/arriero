---
schema: 1
engine: vllm
primaryName: "--tool-strict-level"
title: "--tool-strict-level"
summary: Серверный нижний порог строгости вызовов инструментов через structural tags. `function` грамматикой фиксирует разметку вызова и имя функции для любого запроса с `tools`, `parameter` дополнительно фиксирует схемы аргументов, как если бы клиент пометил каждый инструмент `strict: true`.
group: Frontend
related:
  - --enable-auto-tool-choice
  - --tool-call-parser
  - --tool-parser-plugin
  - --structured-outputs-config
  - --reasoning-parser
---

# --tool-strict-level

## Кратко

Большинство OpenAI-совместимых клиентов и агентных фреймворков не выставляют `strict` у инструментов. При `tool_choice="auto"` модель тогда генерирует вызов без грамматики, и битая разметка или выдуманное имя функции уходят в ответ. Флаг позволяет оператору поднять строгость для всех запросов с инструментами, независимо от того, что прислал клиент.

Порог только ужесточает: инструменты, которые клиент пометил `strict: true`, сохраняют свою схему на любом уровне. Обязанности вызвать инструмент флаг не добавляет: при `tool_choice="auto"` обычный текстовый ответ остается допустимым.

## Оригинальная справка

```text
Server-side floor for structural-tag based tool calling, applied on top
of the per-tool `strict` field. `auto` follows the request's tool choice
and per-tool strictness; `function` constrains the
tool-call envelope (markup and function name) for every request with
tools; `parameter` additionally pins argument schemas, as if every tool
were `strict: true`.
```

## Паспорт аргумента

- Флаги: `--tool-strict-level`
- Группа argparse: `Frontend`
- Тип значения: строка-перечисление
- Допустимые значения: `auto`, `function`, `parameter`
- Значение по умолчанию: `auto`
- Эффективное значение: не переопределяется, но действует только при одновременном выполнении условий: включены `--enable-auto-tool-choice` и `--tool-call-parser`, у выбранного парсера задан `structural_tag_model`, переменная окружения `VLLM_ENFORCE_STRICT_TOOL_CALLING` не выключена (по умолчанию `true`)
- Где объявлен: `vllm/entrypoints/launchers/cli_args.py:BaseFrontendArgs.tool_strict_level`
- Этап применения: HTTP-слой, `adjust_request` парсера перед отправкой запроса в движок; ограничение исполняет backend structured outputs на каждом шаге декодирования

## Что меняет в движке

Значение разбирается в `ToolStrictLevel` (`AUTO=0`, `FUNCTION=1`, `PARAMETER=2`) в `ParserManager.get_parser` и записывается в класс парсера: обычный `DelegatingParser`, Harmony (gpt-oss), Kimi K3 и Cohere Command получают его одинаково. Флаг передается в сервинги Chat Completions, Responses и Anthropic Messages.

В `DelegatingParser._apply_structural_tag` для запроса с непустым `tools` и `tool_choice` `auto`, `required` или именованным:

1. `resolve_tool_strictness(tools, tool_choice, level)` решает, нужен ли structural tag. При `tool_choice="auto"`, уровне `auto` и отсутствии инструментов со `strict: true` тег не строится, и вызов извлекается из сырого текста, как раньше. На уровнях `function` и `parameter` тег строится всегда.
2. Каждому инструменту в копии запроса выставляется `strict = (level >= PARAMETER) or strict_from_request`. Запрос клиента не меняется.
3. Тег строится по шаблону модели (`get_model_structural_tag`, xgrammar-шаблоны и собственный реестр vLLM). Разметка вызова и имя функции ограничены всегда; аргументы ограничены схемой только у `strict`-инструментов, у остальных — общим синтаксисом аргументов.

Если в запросе одновременно `tool_choice="auto"` и `response_format`, которого xgrammar не поддерживает, ограничение вызовов не применяется (предупреждение `Tool calls are not constrained for tool_choice=auto with structured outputs ...`), действует только ограничение формата ответа.

Какие парсеры поддерживают structural tags, задается атрибутом `structural_tag_model` в классах `vllm/tool_parsers/*.py`; у парсеров с `structural_tag_model = None` флаг ничего не меняет. Список меняется между релизами, проверяйте его по исходникам своей версии.

## Значения и формат

- `auto` — прежнее поведение: тег при `required`/именованном выборе всегда, при `auto` — только если хотя бы один инструмент `strict: true`.
- `function` — тег для любого запроса с инструментами; разметка и имя функции ограничены, аргументы свободны, если инструмент не `strict`.
- `parameter` — то же плюс схемы аргументов всех инструментов, как при `strict: true`.
- `VLLM_ENFORCE_STRICT_TOOL_CALLING=false` отключает structural tags целиком и имеет приоритет над флагом.

## Когда использовать

- `function` — агентные клиенты, которые не ставят `strict`, и модель время от времени выдает битую разметку вызова или несуществующее имя функции.
- `parameter` — клиенты присылают схемы в стиле OpenAI strict (`additionalProperties: false`, все поля в `required`, опциональные через `null`), и нужно, чтобы аргументы им гарантированно соответствовали.
- Не включайте `parameter`, если клиенты присылают схемы с конструкциями, которые грамматика не выражает или выражает иначе, чем ожидает клиент: модель будет вынуждена генерировать аргументы по букве схемы.
- Бесполезен без `--enable-auto-tool-choice` и парсера со structural tags.

## Влияние на производительность и память

- **VRAM.** Не влияет: грамматика и маски живут на хосте.
- **CPU и latency.** Каждый запрос с инструментами начинает проходить через grammar backend: компиляция тега при первом появлении набора инструментов и маска логитов на каждом шаге. Под нагрузкой с разнообразными наборами инструментов это заметный CPU на хосте (см. `--structured-outputs-config`).
- **Качество.** Ограничение исключает битую разметку и несуществующие имена; на уровне `parameter` — и несоответствие схеме. Выбор, вызывать ли инструмент, остается за моделью.

## Взаимодействие с другими аргументами

- `--enable-auto-tool-choice`, `--tool-call-parser`: обязательны; без них парсер инструментов не создается.
- `--tool-parser-plugin`: плагинный парсер получает уровень так же, если объявляет `structural_tag_model`.
- `--structured-outputs-config`: backend исполняет грамматику тега; его ограничения на схемы действуют и здесь.
- `--reasoning-parser`: тег строится без учета блока рассуждений (`reasoning=False`), рассуждения разбираются отдельно.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, а вызовы по-прежнему иногда битые. **Причина:** у выбранного парсера `structural_tag_model = None`, не включен `--enable-auto-tool-choice` или выставлен `VLLM_ENFORCE_STRICT_TOOL_CALLING=false`. **Проверка:** класс парсера в `vllm/tool_parsers/`, переменные окружения инстанса.
- **Симптом:** в логе `Tool calls are not constrained for tool_choice=auto with structured outputs because xgrammar does not support the structured output constraint; the structured output constraint applies.` **Причина:** запрос совмещает инструменты и `response_format`, который xgrammar не поддерживает. **Действие:** штатно; ограничение вызовов для таких запросов не работает.
- **Симптом:** после `parameter` модель заполняет необязательные поля странными значениями. **Причина:** схема клиента не в strict-стиле, грамматика требует буквального соответствия. **Лечение:** `function` вместо `parameter` или исправление схем.
- **Подтверждение принятого значения:** строка `non-default args: {...}` при старте содержит `tool_strict_level`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-auto-tool-choice --tool-call-parser hermes --tool-strict-level function
```

```bash
vllm serve /models/Qwen3-Coder-30B-A3B-Instruct --enable-auto-tool-choice --tool-call-parser qwen3_coder --tool-strict-level parameter
```

## Источники

- `vllm/vllm/entrypoints/launchers/cli_args.py`
- `vllm/vllm/tool_parsers/tool_strict_level.py`
- `vllm/vllm/tool_parsers/structural_tag_registry.py`
- `vllm/vllm/tool_parsers/abstract_tool_parser.py`
- `vllm/vllm/parser/parser_manager.py`
- `vllm/vllm/parser/abstract_parser.py`
- `vllm/vllm/envs.py`
- `vllm/docs/features/tool_calling.md`
