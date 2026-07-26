---
schema: 1
primaryName: "--ctx-checkpoints"
title: "--ctx-checkpoints"
summary: "Максимум context checkpoints на слот. Нужен для восстановления cache при SWA/hybrid/recurrent memory; на спекулятивные checkpoints (spec_ckpt) не влияет."
category: "Параметры llama-server"
valueType: "number"
valueHint: "N"
aliases:
  - "-ctxcp"
  - "--ctx-checkpoints"
  - "--swa-checkpoints"
allowedValues: []
env:
  - "LLAMA_ARG_CTX_CHECKPOINTS"
related:
  - "--checkpoint-min-step"
  - "--cache-prompt"
  - "--cache-ram"
  - "--swa-full"
  - "--ctx-size"
---

# --ctx-checkpoints

## Кратко

`--ctx-checkpoints` задает `common_params::n_ctx_checkpoints`: максимум context checkpoints, которые сервер хранит на слот.

По умолчанию `32`. Значение `0` — фактически любое `<= 0`, парсер не отклоняет отрицательные — отключает создание checkpoints (все проверки в коде имеют вид `n_ctx_checkpoints > 0`).

Спекулятивный checkpoint (`slot.spec_ckpt`) — отдельный механизм, создаваемый независимо от этого флага и `--checkpoint-min-step`; предупреждение `speculative decoding will use checkpoints` относится к нему, а не к этому параметру.

## Оригинальная справка llama.cpp

```text
max number of context checkpoints to create per slot (default: 32)
[(more info)](https://github.com/ggml-org/llama.cpp/pull/15293)
```

## Паспорт аргумента

- Основное имя: `--ctx-checkpoints`
- Алиасы: `-ctxcp`, `--ctx-checkpoints`, `--swa-checkpoints`
- Значение по умолчанию: `32`
- Переменная окружения: `LLAMA_ARG_CTX_CHECKPOINTS`
- Поле llama.cpp: `common_params::n_ctx_checkpoints`
- Этап применения: инициализация server context и prompt processing

## Что меняет в llama-server

Если `n_ctx_checkpoints > 0`, сервер пишет `context checkpoints enabled, max = ..., min spacing = ...`. Checkpoints создаются для completion tasks, когда context memory нельзя просто откатить частичным sequence removal: full removal, bounded recurrent state или SWA.

Начиная с https://github.com/ggml-org/llama.cpp/pull/20288 обычные mid-prompt checkpoints пропускаются: checkpoint создается либо ровно на границе перед последним user-сообщением (`n_before_user`, prompt batch принудительно рвется на этой границе), либо около конца промпта — за `4 + n_ubatch` и за `4` токена до конца (`checkpoint_offsets`). После multimodal (mtmd) чанков checkpoint не создается.

Checkpoint (`common_prompt_checkpoint`) хранит `n_tokens`, `pos_min`/`pos_max` и два сериализованных state-блоба — `data_tgt` и `data_dft` (target- и draft-контексты), снятые через `llama_state_seq_*` с флагом `LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY`, то есть только «неоткатываемую» часть памяти (SWA-окно/recurrent state), а не весь KV cache; размер checkpoint = `data_tgt.size() + data_dft.size()`.

Восстановление срабатывает, когда `pos_min` памяти `>= pos_min_thold = max(0, pos_next - n_swa - (has_new_tokens ? 0 : 1))` (https://github.com/ggml-org/llama.cpp/pull/24110): берется последний checkpoint с `pos_min < pos_min_thold || pos_min == 0`, иначе — полная переобработка промпта.

Когда checkpoints переполняют лимит, самый старый удаляется. Checkpoints также сохраняются в `server_prompt_cache` вместе с prompt state.

## Значения и формат

- `0` и любое отрицательное (парсер знак не валидирует): отключить checkpoints.
- Положительное число: максимум checkpoints на слот.
- Отрицательные значения не документированы; используйте `0` для отключения.

## Когда использовать

Оставляйте дефолт для современных моделей с SWA/hybrid/recurrent memory, если используете prompt caching. Уменьшайте, если RAM usage от prompt cache/checkpoints слишком высокий. Ставьте `0` только после проверки, что cache restore не приводит к полному re-processing.

## Влияние на производительность и память

Checkpoints занимают RAM/state memory и добавляют работу при создании/восстановлении, но могут предотвращать дорогой full prompt re-processing. В логах видны размер checkpoint в MiB и сообщения `restored context checkpoint`.

## Взаимодействие с другими аргументами

- `--checkpoint-min-step`: минимальный интервал между checkpoints.
- `--cache-prompt`: основной потребитель восстановленного cache.
- `--cache-ram`: сохраняет prompt states вместе с checkpoints.
- `--swa-full`: может убрать необходимость в части SWA checkpoint behavior ценой большего SWA cache.

## INI-пресеты и router-режим

В INI используйте `ctx-checkpoints = 32` или `swa-checkpoints = 32`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- `context checkpoints disabled` означает значение `--ctx-checkpoints` `<= 0`.
- `created context checkpoint %d of %d (pos_min = ..., pos_max = ..., n_tokens = ..., size = ... MiB)` — нормальный лог создания; второе число — лимит на слот.
- `forcing full prompt re-processing due to lack of cache data` часто указывает, что checkpoint не хватило или он был invalidated.
- `erased invalidated context checkpoint (... pos_next = ...)` — при reuse стираются checkpoints с `pos_max > pos_next`.
- `erasing old context checkpoint` означает достижение лимита.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-checkpoints 32 --checkpoint-min-step 8192
```

```bash
llama-server --model /models/model.gguf --ctx-checkpoints 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-task.h`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/15293
- https://github.com/ggml-org/llama.cpp/pull/20288
- https://github.com/ggml-org/llama.cpp/pull/24110
