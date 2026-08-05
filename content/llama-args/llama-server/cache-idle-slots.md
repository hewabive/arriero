---
schema: 1
primaryName: "--cache-idle-slots"
title: "--cache-idle-slots"
summary: "Сохраняет idle slots в RAM prompt cache при старте новой задачи; при `--kv-unified` дополнительно очищает их KV. Требует включенный `--cache-ram`."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--cache-idle-slots"
  - "--no-cache-idle-slots"
allowedValues: []
env:
  - "LLAMA_ARG_CACHE_IDLE_SLOTS"
related:
  - "--kv-unified"
  - "--cache-ram"
  - "--parallel"
  - "--cache-prompt"
---

# --cache-idle-slots

## Кратко

`--cache-idle-slots` задает `common_params::cache_idle_slots`. При запуске новой задачи сервер сохраняет prompt каждого idle slot в RAM prompt cache. Если включен `--kv-unified`, slot KV очищается безусловно — независимо от успеха сохранения — чтобы освободить общий unified KV; без unified KV очистка не освобождает переиспользуемое место, поэтому slot сохраняет свой KV в VRAM, а в prompt cache публикуется только RAM-копия.

По умолчанию включено, но автоматически отключается при `--cache-ram 0`. `--kv-unified` больше не обязателен (изменено в [PR #24190](https://github.com/ggml-org/llama.cpp/pull/24190)).

## Оригинальная справка llama.cpp

```text
save idle slots to the prompt cache on new task, and clear them when using unified KV (default: enabled, requires cache-ram)
```

## Паспорт аргумента

- Основное имя: `--cache-idle-slots`
- Алиасы: `--cache-idle-slots`, `--no-cache-idle-slots`
- Значение по умолчанию: enabled
- Переменная окружения: `LLAMA_ARG_CACHE_IDLE_SLOTS`
- Поле llama.cpp: `common_params::cache_idle_slots`
- Этап применения: инициализация server context и scheduler loop

## Что меняет в llama-server

На `init()` сервер проверяет единственное условие: при `--cache-ram 0` пишет `--cache-idle-slots requires --cache-ram, disabling` и отключает флаг. Затем логирует выбранный режим: с unified KV — `idle slots will be saved to prompt cache and cleared upon starting a new task`, без него — `idle slots will be saved to prompt cache upon starting a new task`.

Когда включено, при запуске задач `COMPLETION`/`INFILL`/`EMBEDDING`/`RERANK` — после успешного `launch_slot_with_task` — каждый idle slot сохраняется через `prompt_save()` в `server_prompt_cache`; пустые prompts пропускаются, а после каждого успешного save вызывается `prompt_cache->update()` (возможна эвикция и лог `cache state`). При `--kv-unified` `prompt_clear()` вызывается безусловно, вне проверки успеха сохранения: KV слота очищается даже если save был пропущен (пустой prompt, prompt уже в кэше) или не удался из-за `bad_alloc` — тогда state теряется.

## Значения и формат

- `--cache-idle-slots`: включить.
- `--no-cache-idle-slots`: выключить.
- В INI boolean значения поддерживаются через обычные и negated keys.

## Когда использовать

Оставляйте включенным для серверов с несколькими слотами и длинными prompts: с `--kv-unified` это освобождает общий KV, без него — заранее публикует RAM-копии состояний для последующего restore. Выключайте, если RAM-cache слишком дорог или если нужно, чтобы idle slots не сериализовались.

Учтите: при `--kv-unified` работает отдельный механизм `try_clear_idle_slots()` — когда decode не находит места в KV, сервер пуржит idle-слоты по одному (лог `purging slot %d with %zu tokens`) независимо от `--cache-idle-slots` и без сохранения в prompt cache. Поэтому `--no-cache-idle-slots` при unified KV не защищает состояние idle-слота под давлением — без флага оно при purge просто теряется.

## Влияние на производительность и память

С unified KV снижает давление на общий KV-cache, перенося часть состояния в RAM; без unified KV память KV не освобождается, добавляется только RAM-копия. Новая задача может стартовать быстрее, чем полный prompt replay, если state удачно восстановлен из prompt cache; restore идет через `get_available_slot()`/`prompt_load()` и срабатывает только для задач `COMPLETION`.

## Взаимодействие с другими аргументами

- `--cache-ram`: обязательное условие, должен быть не `0`.
- `--kv-unified`: не обязателен; определяет, очищается ли KV idle slot при старте новой задачи (безусловно, независимо от успеха сохранения).
- `--parallel`: чем больше слотов, тем чаще есть idle states для сохранения.
- `--cache-prompt`: влияет на reuse восстановленного состояния.

## INI-пресеты и router-режим

В INI используйте `cache-idle-slots = true` или `no-cache-idle-slots = true`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- Ищите лог `idle slots will be saved to prompt cache and cleared upon starting a new task` (с unified KV) или `idle slots will be saved to prompt cache upon starting a new task` (без него).
- Per-slot лог `saving idle slot to prompt cache` подтверждает сохранение конкретного idle slot.
- При `--cache-ram 0` сервер пишет warning `--cache-idle-slots requires --cache-ram, disabling`.
- При нехватке RAM смотрите `cache state` и уменьшайте `--cache-ram`.

## Примеры

```bash
llama-server --model /models/model.gguf --kv-unified --cache-ram 4096 --cache-idle-slots
```

```bash
llama-server --model /models/model.gguf --parallel 4 --cache-ram 8192
```

```bash
llama-server --model /models/model.gguf --no-cache-idle-slots
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/24190
