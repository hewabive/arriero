---
schema: 1
engine: vllm
primaryName: "--cohere-is-reasoning-model"
title: "--cohere-is-reasoning-model"
summary: Как рассуждения модели выглядят в ответе `/cohere/v2/chat`: блоком `thinking` (по умолчанию) или полем `tool_plan` на ходах с вызовами инструментов. На промпт и генерацию не влияет.
group: Frontend
related:
  - --cohere-format
  - --tokenizer-mode
  - --reasoning-parser
  - --enable-auto-tool-choice
---

# --cohere-is-reasoning-model

## Кратко

Флаг переключает форму ответа Cohere-совместимого эндпоинта. Command-модели старого поколения печатали план перед вызовом инструментов и отдавали его в поле `tool_plan`; современные reasoning-модели отдают то же самое как отдельный блок `thinking`.

Второй из немногих аргументов группы `Frontend` со значением по умолчанию `true`. И он не имеет никакого эффекта нигде, кроме `/cohere/v2/chat`.

## Оригинальная справка

```text
Cohere ``/cohere/v2/chat`` only. Whether the served model is a
reasoning Command-family model. When True (default), the assistant's
chain-of-thought is surfaced as a ``thinking`` content block (or
``content-*`` events on the stream). When False, reasoning is
surfaced as Cohere's ``tool_plan`` field (or ``tool-plan-delta``
events) whenever the model emits tool calls, matching older non-
reasoning Command models. Has no effect on the non-Cohere
endpoints.
```

## Паспорт аргумента

- Флаги: `--cohere-is-reasoning-model`, `--no-cohere-is-reasoning-model`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` (`false`); при отсутствии обоих действует `true`
- Значение по умолчанию: `true`
- Эффективное значение: не переопределяется, но применяется только если эндпоинт вообще поднят — для этого нужны `VLLM_ENABLE_COHERE_API=1` и установленный пакет `cohere`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.cohere_is_reasoning_model`
- Этап применения: инициализация состояния генеративного роутера → HTTP-слой, преобразование ответа в формат Cohere v2

## Что меняет в движке

Значение попадает в `CohereServingChatV2._is_reasoning_model` и читается в трех местах (`vllm/entrypoints/cohere/serving.py`):

1. **Нестриминговый ответ** (`_chat_completion_to_v2`). При `false`, если на ходу есть и `tool_calls`, и текст рассуждений, этот текст переносится в `tool_plan`, а блок `THINKING` из `content` удаляется. При `true` блок остается на месте, а `tool_plan` не заполняется никогда.
2. **Цитаты.** Цитата типа `THINKING_CONTENT` при `false` переписывается в тип `PLAN` — чтобы соответствовать тому, что рассуждение уехало в `tool_plan`.
3. **Стриминг** (`_handle_thinking_delta`). При `false` дельты рассуждений идут событиями `tool-plan-delta` (без парных start/end), при `true` — как обычный блок `thinking` с `content-start`/`content-delta`/`content-end`.

Ни промпт, ни sampling, ни разбор tool-call'ов флаг не трогает: он работает на этапе перевода уже готового `ChatCompletion` в схему Cohere v2. Сам текст рассуждений порождается парсером рассуждений, заданным отдельно.

## Значения и формат

- `true` (по умолчанию): рассуждения — блок `thinking` / события `content-*`.
- `false` (`--no-cohere-is-reasoning-model`): рассуждения — `tool_plan` / события `tool-plan-delta`, и только на ходах с вызовами инструментов.
- Отсутствие обоих флагов равно `true`, а не «решит движок».
- Автоопределения по модели нет — в коде это помечено как временное решение до появления декларации возможностей модели.

## Когда использовать

- Обслуживаете Command-модель предыдущего поколения через `/cohere/v2/chat`, и клиент ждет `tool_plan`: ставьте `--no-cohere-is-reasoning-model`.
- Оставляйте значение по умолчанию для современных reasoning-моделей Command.
- Не трогайте, если Cohere-эндпоинт не включен: без `VLLM_ENABLE_COHERE_API=1` и пакета `cohere` роут не регистрируется, и флаг ни на что не влияет.
- Не используйте как выключатель размышлений: он меняет только упаковку ответа. Отключать генерацию рассуждений нужно через `--default-chat-template-kwargs` или запросные параметры.

## Влияние на производительность и память

Не влияет: работа сводится к переносу уже сформированного текста между полями ответа и к выбору типа SSE-события.

## Взаимодействие с другими аргументами

- `--cohere-format`: тоже «только Cohere», но относится к **промпту** (cmd3/cmd4), а этот флаг — к **ответу**. Их часто путают.
- `--tokenizer-mode`: значение `cohere` нужно для корректного рендеринга Command-промпта; сам эндпоинт `/cohere/v2/chat` работает и без него, но результат будет собран не тем рендерером.
- `--reasoning-parser`: именно он выделяет текст рассуждений из вывода; без него `msg.reasoning` пуст и переключать нечего.
- `--enable-auto-tool-choice`: `tool_plan` заполняется только на ходах с вызовами инструментов, поэтому без работающего tool-слоя `false` внешне неотличим от `true`.

## Типовые проблемы и диагностика

- **Симптом:** клиент Cohere SDK ждет `tool_plan`, получает блок `thinking`. **Причина:** значение по умолчанию `true`. **Лечение:** `--no-cohere-is-reasoning-model`.
- **Симптом:** после переключения в `false` ничего не изменилось. **Причина:** ход без вызовов инструментов либо пустое `reasoning` — условие переноса не выполняется. **Проверка:** тот же запрос с `tools` и заданным `--reasoning-parser`. **Лечение:** ничего, поведение ожидаемое.
- **Симптом:** `/cohere/v2/chat` отвечает 404. **Причина:** не задан `VLLM_ENABLE_COHERE_API=1` или не установлен пакет `cohere`. **Проверка:** предупреждение при старте — `VLLM_ENABLE_COHERE_API is not set; /cohere/v2/chat endpoint ...` либо `... but the cohere SDK is not installed ...`. **Лечение:** выставить переменную и установить пакет.
- **Симптом:** в стриме приходят `tool-plan-delta` без парных событий начала/конца блока. **Причина:** так устроено это событие. **Лечение:** действий не требуется.
- **Подтверждение принятого значения:** ответ `/cohere/v2/chat` на запрос с инструментами — наличие `tool_plan` либо блока `thinking`.

## Примеры

```bash
VLLM_ENABLE_COHERE_API=1 vllm serve /models/command-a --tokenizer-mode cohere --no-cohere-is-reasoning-model
```

```bash
VLLM_ENABLE_COHERE_API=1 vllm serve /models/command-a-plus --tokenizer-mode cohere --cohere-is-reasoning-model --enable-auto-tool-choice --tool-call-parser cohere_command4
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/cohere/serving.py`
- `vllm/vllm/entrypoints/cohere/api_router.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
- `vllm/vllm/envs.py`
