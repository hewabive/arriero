---
schema: 1
engine: vllm
primaryName: "--anthropic-disabled-thinking-effort"
title: "--anthropic-disabled-thinking-effort"
summary: Какой `reasoning_effort` подставить в Anthropic-запрос `/v1/messages` с `thinking: {"type": "disabled"}`. `auto` сам выбирает между `none` и `low` пробным рендерингом шаблона; явное значение нужно, когда модель не умеет отключать рассуждения.
group: Frontend
related:
  - --reasoning-parser
  - --chat-template
  - --default-chat-template-kwargs
  - --tool-strict-level
---

# --anthropic-disabled-thinking-effort

## Кратко

Anthropic-клиенты (Claude Code, SDK) отключают рассуждения полем `thinking: {"type": "disabled"}`. Эндпоинт `/v1/messages` vLLM переводит запрос в Chat Completions, а там рассуждениями управляют `reasoning_effort` и производный от него `enable_thinking` в шаблоне чата. Флаг задает, во что превратится «disabled»: `none` выключает рассуждения у моделей, которые это умеют, а `low` годится для моделей, которые думают всегда или отвергают `none`.

На запросы через прокси arriero к управляемому vLLM флаг не влияет: arriero сам переводит Anthropic-запросы в Chat Completions и передает отключение рассуждений через `chat_template_kwargs` (`docs/ANTHROPIC_OPENAI_BRIDGE.md`, arriero).

## Оригинальная справка

```text
Anthropic ``/v1/messages`` only. The ``reasoning_effort`` used for
requests with ``thinking: {"type": "disabled"}``. ``none`` turns thinking
off for models that support it; ``low`` suits models that always think
(e.g. GLM-5.3) or reject ``none`` (e.g. gpt-oss). ``auto`` (default) uses
``low`` when the renderer rejects ``none`` or renders it the same as a
thinking effort, and ``none`` otherwise.
```

## Паспорт аргумента

- Флаги: `--anthropic-disabled-thinking-effort`
- Группа argparse: `Frontend`
- Тип значения: строка-перечисление
- Допустимые значения: `auto`, `none`, `low`, `medium`, `high`, `xhigh`, `max`
- Значение по умолчанию: `auto`
- Эффективное значение: при `auto` значение определяется один раз на процесс, при первом запросе с `thinking.type == "disabled"`, пробным рендерингом шаблона (см. ниже) и дальше кэшируется. Явное значение используется как есть
- Где объявлен: `vllm/entrypoints/launchers/cli_args.py:BaseFrontendArgs.anthropic_disabled_thinking_effort`
- Этап применения: HTTP-слой, преобразование Anthropic-запроса в `ChatCompletionRequest` в `AnthropicServingMessages`

## Что меняет в движке

**Подстановка.** В `AnthropicServingMessages.create_messages` для запроса с `thinking.type == "disabled"` берется эффективное значение, и `_handle_thinking` записывает его в `req.reasoning_effort`. Это делается **после** `_handle_output_config`, поэтому отключение рассуждений побеждает `output_config.effort` того же запроса. Запросы с `thinking.type` `enabled` (бюджет токенов) и `adaptive` флаг не затрагивают. `count_tokens` не затрагивается.

**Дальше по Chat Completions.** `ChatCompletionRequest.build_chat_params` передает в шаблон `reasoning_effort` и, если клиент сам не прислал `chat_template_kwargs.enable_thinking`, добавляет `enable_thinking = (reasoning_effort != "none")`. Так `none` выключает рассуждения у шаблонов, которые читают `enable_thinking`, а `low` оставляет их включенными с минимальной глубиной.

**Режим `auto`.** `_probe_disabled_thinking_effort` рендерит пробный чат (`Hi` от пользователя) с `reasoning_effort="none"`:

- рендеринг падает или возвращает ошибку — выбирается `low` (шаблон не принимает `none`, как у gpt-oss);
- промпт для `none` совпадает с промптом хотя бы одного из `low`/`medium`/`high`/`xhigh`/`max` — выбирается `low` (шаблон игнорирует `none`, например GLM-5.3 трактует неизвестное значение как `max`);
- иначе — `none`.

Результат печатается в лог: `Anthropic thinking.type=disabled maps to reasoning_effort='none'` (или `'low'`).

## Значения и формат

- `auto` — выбор пробным рендерингом, один раз на процесс.
- `none` — выключить рассуждения; для шаблонов без поддержки `enable_thinking`/`reasoning_effort` ничего не изменится.
- `low` — минимальная глубина для моделей, которые всегда думают или не принимают `none`.
- `medium`, `high`, `xhigh`, `max` — синтаксически допустимы, но превращают «disabled» в заметные рассуждения. `max` — значение DeepSeek V4, в стандартном OpenAI API его нет.
- Другие значения отвергает argparse на старте.

## Когда использовать

- Оставьте `auto` для большинства моделей: проба по шаблону сама отличает модели с выключаемыми рассуждениями от остальных.
- `low` явно — если `auto` выбрал `none`, а модель все равно рассуждает (шаблон различает `none` текстуально, но модель обучена думать всегда), либо чтобы не зависеть от пробы.
- `none` явно — если проба ошибочно выбрала `low`, а вы знаете, что модель корректно выключает рассуждения.
- Не трогайте, если к vLLM ходят только через прокси arriero или только по OpenAI-совместимым эндпоинтам.

## Влияние на производительность и память

- **VRAM и время старта.** Не влияет.
- **Latency и расход токенов.** Прямо зависят от выбора: `none` убирает блок рассуждений, `low` оставляет короткий. Для клиента, который отключил рассуждения ради скорости, `low` все равно дает лишние токены до ответа.
- **Первый disabled-запрос в режиме `auto`.** Платит за несколько рендерингов шаблона (до шести); дальше значение кэшировано.

## Взаимодействие с другими аргументами

- `--reasoning-parser`: решает, выделяются ли рассуждения из ответа в отдельные блоки; этот флаг решает, будут ли они сгенерированы.
- `--chat-template`: проба `auto` рендерит именно тот шаблон, который реально применяется; смена шаблона может изменить выбор.
- `--default-chat-template-kwargs`: серверные kwargs шаблона, в том числе `enable_thinking`. `enable_thinking` в `chat_template_kwargs` запроса блокирует производное значение от `reasoning_effort`.
- `--tool-strict-level`: соседняя настройка того же `/v1/messages`-пути, но для вызовов инструментов.

## Типовые проблемы и диагностика

- **Симптом:** Claude Code или SDK отключает рассуждения, а ответы все равно начинаются с длинного блока рассуждений. **Причина:** выбран `low` (проба или явное значение), либо шаблон модели не умеет выключать рассуждения. **Проверка:** строка `Anthropic thinking.type=disabled maps to reasoning_effort=...` в логе после первого такого запроса. **Лечение:** если модель поддерживает выключение — `--anthropic-disabled-thinking-effort none`.
- **Симптом:** запросы с отключенными рассуждениями падают с ошибкой рендеринга шаблона. **Причина:** явно задан `none` для шаблона, который его не принимает. **Лечение:** `auto` или `low`.
- **Симптом:** флаг задан, а поведение через arriero не изменилось. **Причина:** прокси arriero переводит Anthropic-запросы сам и в `/v1/messages` vLLM не ходит. **Проверка:** трейс запроса в arriero помечен `translated: true`.
- **Подтверждение принятого значения:** строка `non-default args: {...}` при старте; для `auto` — строка выбора в логе после первого disabled-запроса.

## Примеры

```bash
vllm serve /models/Qwen3-4B --reasoning-parser qwen3 --anthropic-disabled-thinking-effort none
```

```bash
vllm serve /models/GLM-4.7 --reasoning-parser glm47 --anthropic-disabled-thinking-effort low
```

## Источники

- `vllm/vllm/entrypoints/launchers/cli_args.py`
- `vllm/vllm/entrypoints/anthropic/serving.py`
- `vllm/vllm/entrypoints/anthropic/protocol.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `docs/ANTHROPIC_OPENAI_BRIDGE.md` (arriero)
