---
schema: 1
primaryName: "--cache-ram"
title: "--cache-ram"
summary: "Лимит RAM-cache для сериализованных prompt states. `0` отключает, `-1` снимает MiB-лимит, по умолчанию 8192 MiB."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-cram"
  - "--cache-ram"
allowedValues: []
env:
  - "LLAMA_ARG_CACHE_RAM"
related:
  - "--cache-idle-slots"
  - "--cache-prompt"
  - "--ctx-checkpoints"
  - "--kv-unified"
---

# --cache-ram

## Кратко

`--cache-ram` задает `common_params::cache_ram_mib`: лимит RAM для `server_prompt_cache`, который хранит serialized sequence states и checkpoints для prompt reuse между слотами/вытеснениями.

Это не размер KV-cache в VRAM. Это дополнительный RAM-уровень prompt cache.

## Оригинальная справка llama.cpp

```text
set the maximum cache size in MiB (default: 8192, -1 - no limit, 0 - disable)
[(more info)](https://github.com/ggml-org/llama.cpp/pull/16391)
```

## Паспорт аргумента

- Основное имя: `--cache-ram`
- Алиасы: `-cram`, `--cache-ram`
- Значение по умолчанию: `8192`
- Специальные значения: `-1` без лимита по MiB, `0` выключить
- Переменная окружения: `LLAMA_ARG_CACHE_RAM`
- Поле llama.cpp: `common_params::cache_ram_mib`
- Этап применения: кэш создается в `load_model()` server context
- Регистрация: examples `SERVER` и `CLI` — флаг доступен и в `llama-cli`

## Что меняет в llama-server

Если значение не `0`, `load_model()` создает `server_prompt_cache(limit_size_mib, limit_tokens)`, передавая вторым аргументом `n_ctx` (суммарный контекст всех слотов), пишет `prompt cache is enabled, size limit: ...` и подсказку ``use `--cache-ram 0` to disable the prompt cache``. Если `0`, пишет ``prompt cache is disabled - use `--cache-ram N` to enable it``; в обоих случаях логируется ссылка `for more info see https://github.com/ggml-org/llama.cpp/pull/16391`.

Cache хранит prompt states в RAM: каждый entry — сериализованный state target-контекста (плюс draft-контекста при speculative decoding), клон токенов и checkpoints; каждый save логируется как `- saving prompt with length %d, total state size = %.3f MiB (draft: %.3f MiB)`. Эвикция строго oldest-first (FIFO, `pop_front`), не LRU; код всегда оставляет хотя бы один state. Кроме лимита по MiB действует токенный лимит: `update()` вытесняет старые states, пока `n_tokens() > limit_tokens`, причем при `limit_size > 0` токенный лимит динамически повышается до `limit_size / size_per_token`; лог эвикции — `- cache token limit (%zu, est: %zu) reached, removing oldest entry (size = %.3f MiB)`.

Главный путь обновления кэша — `get_available_slot()`, только для задач `COMPLETION`: при выборе слота по LRU (всегда) или по LCP-похожести с `f_keep < 0.5` выполняется `prompt_save()` текущего слота → `prompt_load()` лучшего кэшированного → при неудаче `prompt_clear()` → `prompt_cache->update()`; в логах `updating prompt cache` и `prompt cache update took %.2f ms`. Hit — это перемещение: восстановленный entry удаляется из кэша (state «переезжает» в слот, копии не остается), и восстанавливаются только entries с `f_keep_cur >= 0.25`. При save выполняется дедупликация: если текущий prompt — полный префикс уже кэшированного, save пропускается (`- prompt is already in the cache, skipping`), а кэшированные prompts, полностью содержащиеся в новом, удаляются (`- removing obsolete cached prompt with length %d`).

## Значения и формат

- `0`: отключить RAM prompt cache.
- `-1`: без лимита по MiB (`limit_size = 0`); токенный лимит `limit_tokens = n_ctx` продолжает действовать.
- `N > 0`: лимит в MiB.

## Когда использовать

Оставляйте включенным, если используете несколько слотов, `--cache-idle-slots` или часто переключаете похожие длинные prompts. Отключайте на машинах с малым RAM или когда важнее предсказуемое потребление памяти.

`-1` снимает только MiB-лимит, токенный лимит `n_ctx` остается: рост RAM ограничен примерно размером state на один полный контекст (плюс один негабаритный entry, так как минимум один state хранится всегда).

## Влияние на производительность и память

Может заметно ускорить возврат к старым prompt states, но потребляет системную RAM пропорционально размеру сериализованных states. При `bad_alloc` код уменьшает limit примерно до 40% текущего размера и вызывает cleanup.

## Взаимодействие с другими аргументами

- `--cache-idle-slots`: требует включенный `--cache-ram`.
- `--kv-unified`: вместе с `--cache-idle-slots` позволяет чистить idle slots, освобождая KV.
- `--ctx-checkpoints`: checkpoints сохраняются вместе с prompt state.
- `--parallel`: больше слотов повышает шанс вытеснений и пользу RAM-cache.
- `--slot-save-path`: с prompt cache не связан — `/slots/:id?action=save|restore` это отдельный файловый механизм save/restore состояния слота.

## INI-пресеты и router-режим

В INI используйте `cache-ram = 4096` или `LLAMA_ARG_CACHE_RAM`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- Логи `prompt cache is enabled/disabled` показывают фактический режим.
- Лог `- cache state: %zu prompts, %.3f MiB (limits: %.3f MiB, %zu tokens, %zu est)` показывает заполнение и оба лимита; в `/metrics` prompt cache не экспортируется — диагностика только по логам.
- Эвикция видна по `- cache size limit reached, removing oldest entry (size = %.3f MiB)` и `- cache token limit (%zu, est: %zu) reached, removing oldest entry (size = %.3f MiB)`.
- При росте RSS уменьшайте `--cache-ram` или ставьте `--cache-ram 0`.

## Примеры

```bash
llama-server --model /models/model.gguf --cache-ram 4096
```

```bash
llama-server --model /models/model.gguf --cache-ram 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
