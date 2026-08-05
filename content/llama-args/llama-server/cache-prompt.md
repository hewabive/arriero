---
schema: 1
primaryName: "--cache-prompt"
title: "--cache-prompt"
summary: "Включает reuse KV-cache для общего prefix между запросами в слоте. По умолчанию включено и может быть переопределено в JSON-запросе `cache_prompt`."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--cache-prompt"
  - "--no-cache-prompt"
allowedValues: []
env:
  - "LLAMA_ARG_CACHE_PROMPT"
related:
  - "--cache-reuse"
  - "--cache-ram"
  - "--cache-idle-slots"
  - "--slot-prompt-similarity"
  - "--ctx-size"
---

# --cache-prompt

## Кратко

`--cache-prompt` задает `common_params::cache_prompt`: default для HTTP-параметра `cache_prompt`. Если включено, сервер сравнивает новый prompt с уже сохраненными токенами слота и переоценивает только несовпадающий suffix.

Это не дисковый cache и не то же самое, что `--cache-ram`. Базовый reuse живет в KV-состоянии слота.

## Оригинальная справка llama.cpp

```text
whether to enable prompt caching (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--cache-prompt`
- Алиасы: `--cache-prompt`, `--no-cache-prompt`
- Значение по умолчанию: enabled
- Переменная окружения: `LLAMA_ARG_CACHE_PROMPT`
- Поле llama.cpp: `common_params::cache_prompt`, затем `task_params::cache_prompt`
- Этап применения: обработка каждого completion task

## Что меняет в llama-server

При старте prompt processing сервер вычисляет longest common prefix между `slot.prompt.tokens` и новым input. Совпавшие токены считаются cached (`n_prompt_tokens_cache`), а в batch попадает только оставшаяся часть.

Даже при 100% совпадении префикса минимум один токен переобрабатывается: сервер делает `n_past--` с предупреждением `need to evaluate at least 1 token for each active slot`, поэтому кэш никогда не покрывает prompt целиком и в метриках всегда есть хотя бы один некэшированный токен.

Если `cache_prompt` выключен, сервер сбрасывает `n_past = 0` и удаляет предыдущие токены слота перед новой обработкой.

## Значения и формат

CLI использует флаги:

- `--cache-prompt`: включить.
- `--no-cache-prompt`: выключить.

В JSON `/completion` можно передать `cache_prompt: true` или `false` для конкретного запроса.

## Когда использовать

Оставляйте включенным для chat, agents и повторяющихся system prompts. Выключайте для тестов воспроизводимости, потому что README предупреждает: разные batch sizes для prompt processing и token generation не гарантируют bit-for-bit одинаковые logits.

## Влияние на производительность и память

При совпадающем prefix сильно снижает prompt evaluation time и TTFT. Память KV слота при этом сохраняется дольше; при большом `--parallel` это может держать больше старого контекста.

## Взаимодействие с другими аргументами

- `--cache-reuse`: работает только при включенном prompt caching и дополнительно ищет совпадающие chunks не только в prefix.
- `--cache-ram`: может сохранять state вытесняемого prompt в RAM.
- `--cache-idle-slots`: при старте новой задачи сохраняет prompt-state idle-слотов в RAM prompt cache (требует `--cache-ram`, иначе отключается); при unified KV слот после сохранения еще и очищается.
- `--kv-unified`: под давлением KV сервер принудительно очищает idle-слоты с закэшированными токенами (лог `purging slot %d with %zu tokens`) — закэшированный prefix таких слотов теряется.
- `--slot-prompt-similarity`: помогает выбрать слот с похожим prompt.
- `--ctx-checkpoints`: помогает восстановить usable cache для SWA/hybrid/recurrent memory.
- Per-request `lora`: смена набора адаптеров в запросе очищает кэш слота (`slot.prompt.tokens.clear()`); при alora кэширование обрезается до начала invocation (лог `only caching to alora invocation start`).

## INI-пресеты и router-режим

В INI используйте `cache-prompt = true` или `no-cache-prompt = true`. В router-режиме применяется в дочернем процессе модели.

## Типовые проблемы и диагностика

- В non-OAI ответе `/completion` смотрите `tokens_cached` и `timings.cache_n`, в OpenAI-совместимом ответе — `usage.prompt_tokens_details.cached_tokens`; поле `n_prompt_tokens_cache` отдает только эндпоинт `/slots`.
- При `LLAMA_SERVER_SLOTS_DEBUG=1` сервер печатает токены вокруг mismatch prefix.
- Для SWA/hybrid/recurrent моделей без context checkpoints кэш частично бесполезен: сервер пишет `forcing full prompt re-processing due to lack of cache data (likely due to SWA or hybrid/recurrent memory, see ...)` и переобрабатывает prompt целиком — смягчается через `--ctx-checkpoints`.
- Для строгих benchmark-сравнений запускайте `--no-cache-prompt`.

## Примеры

```bash
llama-server --model /models/model.gguf --cache-prompt
```

```bash
llama-server --model /models/model.gguf --no-cache-prompt
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
