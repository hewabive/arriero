---
schema: 1
engine: vllm
primaryName: "--exclude-tools-when-tool-choice-none"
title: "--exclude-tools-when-tool-choice-none"
summary: Убирает описания инструментов из промпта, когда запрос пришел с `tool_choice="none"`. По умолчанию описания остаются в промпте и продолжают есть контекст.
group: Frontend
related:
  - --enable-auto-tool-choice
  - --tool-call-parser
  - --enable-prefix-caching
  - --max-model-len
---

# --exclude-tools-when-tool-choice-none

## Кратко

Поведение по умолчанию неочевидно: при `tool_choice="none"` vLLM всё равно передает шаблону полный список `tools`, то есть JSON-схемы функций попадают в промпт и занимают токены — просто модели сказано ими не пользоваться.

Флаг это меняет: при `tool_choice="none"` инструменты в шаблон не передаются вовсе.

## Оригинальная справка

```text
If specified, exclude tool definitions in prompts when
tool_choice='none'.
```

## Паспорт аргумента

- Флаги: `--exclude-tools-when-tool-choice-none`, `--no-exclude-tools-when-tool-choice-none`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false` — описания инструментов остаются в промпте
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.exclude_tools_when_tool_choice_none`
- Этап применения: HTTP-слой, сборка промпта каждого чат-запроса

## Что меняет в движке

Единственное место применения — `OnlineRenderer.render_chat` (`vllm/renderers/online_renderer.py`):

```text
if request.tools is None or (request.tool_choice == "none" and self.exclude_tools_when_tool_choice_none):
    tool_dicts = None
else:
    tool_dicts = [tool.model_dump() for tool in request.tools]
```

`tool_dicts` идет двумя путями. Во-первых, в `chat_template_kwargs["tools"]` — то есть в Jinja-шаблон, который и печатает описания инструментов в промпт. Во-вторых, `tools` участвует в `resolve_chat_template`: непустой список **отключает** приоритет шаблона `AutoProcessor`. Поэтому флаг косвенно меняет и выбор шаблона для мультимодальных моделей, когда запрос пришел с `tool_choice="none"`.

Отдельно от промпта: разбор ответа при `tool_choice="none"` не выполняется в любом случае (`should_adjust_request` в `preprocess_chat` пропускает `adjust_request`, если нет reasoning-парсера и `tool_choice == "none"`), кроме исключения для grammar-совместимых Mistral-токенизаторов.

## Значения и формат

- Включение: `--exclude-tools-when-tool-choice-none`. Выключение: `--no-exclude-tools-when-tool-choice-none`.
- «Не задан» = `false`.
- Влияет ровно на один случай: `tools` в запросе непуст **и** `tool_choice == "none"`. Если `tools` не передан, промпт и так без инструментов; если `tool_choice` иной, инструменты нужны.

## Когда использовать

- Клиент (типичный агентский фреймворк) присылает полный набор инструментов в каждом запросе и выключает их через `tool_choice="none"` на шагах, где вызовы не нужны. Флаг убирает из промпта сотни, а иногда тысячи токенов схем.
- Модель при `tool_choice="none"` всё равно иногда «галлюцинирует» разметку вызова: без описаний в промпте это происходит заметно реже.
- Не включайте, если у вас общий системный префикс с инструментами и включен prefix caching: два разных набора промптов (с инструментами и без) поделят кэш пополам и снизят долю попаданий.
- Не рассчитывайте на флаг как на защиту: он не мешает клиенту прислать `tool_choice="auto"` в следующем запросе.

## Влияние на производительность и память

Влияние идет через длину промпта. Убранные схемы — это меньше входных токенов на запрос: меньше prefill, меньше занятых KV-блоков, выше `Maximum concurrency` при том же бюджете KV-cache. На типичном агентском наборе из десятка инструментов экономия измеряется сотнями токенов на запрос.

Обратная сторона — фрагментация prefix cache: при включенном `--enable-prefix-caching` запросы с инструментами и без них перестают делить общий префикс, если `tool_choice` меняется по ходу диалога.

## Взаимодействие с другими аргументами

- `--enable-auto-tool-choice`, `--tool-call-parser`: на разбор ответа флаг не влияет — только на промпт.
- `--enable-prefix-caching`: см. выше про расхождение префиксов.
- `--max-model-len`: убранные схемы освобождают место в окне контекста, что заметно на длинных диалогах с большим набором инструментов.

## Типовые проблемы и диагностика

- **Симптом:** при `tool_choice="none"` модель всё равно печатает разметку вызова в тексте. **Причина:** описания инструментов остались в промпте (значение по умолчанию). **Проверка:** `POST /tokenize` с тем же телом — в отрендеренном промпте видны схемы. **Лечение:** включить флаг.
- **Симптом:** число входных токенов не изменилось после включения флага. **Причина:** клиент шлет `tool_choice="auto"` или не шлет `tool_choice` вовсе — тогда условие не выполняется. **Проверка:** тело запроса. **Лечение:** ничего, флаг работает только для явного `"none"`.
- **Симптом:** упала доля попаданий prefix cache. **Причина:** промпты разошлись по наличию блока инструментов. **Проверка:** `gpu_prefix_cache_hit_rate` в `/metrics`. **Лечение:** выключить флаг либо привести клиента к единому режиму.
- **Подтверждение принятого значения:** флаг виден в строке `non-default args: {...}` при старте; эффект проверяется сравнением промптов через `POST /tokenize`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-auto-tool-choice --tool-call-parser hermes --exclude-tools-when-tool-choice-none
```

```bash
vllm serve /models/Qwen3-4B --no-exclude-tools-when-tool-choice-none --enable-prefix-caching
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/vllm/renderers/hf.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
