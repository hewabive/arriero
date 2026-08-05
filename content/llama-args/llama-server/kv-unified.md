---
schema: 1
primaryName: "--kv-unified"
title: "--kv-unified"
summary: "Использует единый KV-буфер для всех последовательностей вместо раздельного разделения контекста по слотам. Автоматически включается при `--parallel -1`."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "-kvu"
  - "--kv-unified"
  - "-no-kvu"
  - "--no-kv-unified"
allowedValues: []
env:
  - "LLAMA_ARG_KV_UNIFIED"
related:
  - "--parallel"
  - "--ctx-size"
  - "--cache-idle-slots"
  - "--cache-ram"
---

# --kv-unified

## Кратко

`--kv-unified` задает `common_params::kv_unified`, затем `llama_context_params::kv_unified`: все sequence ids используют один общий KV stream.

В server auto-режиме `--parallel -1` код принудительно ставит `n_parallel = 4` и `kv_unified = true`. Условие в коде — `n_parallel < 0`, то есть auto срабатывает на любом отрицательном значении; парсер server-режима отклоняет только `0`.

## Оригинальная справка llama.cpp

```text
use single unified KV buffer shared across all sequences (default: enabled if number of slots is auto)
```

## Паспорт аргумента

- Основное имя: `--kv-unified`
- Алиасы включения: `-kvu`, `--kv-unified`
- Алиасы выключения: `-no-kvu`, `--no-kv-unified`
- Переменная окружения: `LLAMA_ARG_KV_UNIFIED`
- Поля llama.cpp: `common_params::kv_unified`, `llama_context_params::kv_unified`
- Этап применения: создание `llama_context` и KV-memory

## Что меняет в llama-server

Без unified KV `llama-context.cpp` считает `n_ctx_seq = n_ctx / n_seq_max`; каждый слот фактически получает свою долю контекста. Формула с оговорками: `n_ctx` сначала паддится до кратного 256, частное дополнительно выравнивается через `GGML_PAD(..., 256)`; при `n_ctx_seq == 0` создание контекста падает с `runtime_error("n_ctx_seq == 0")`, а если `n_ctx` не делится на `n_seq_max`, он пересчитывается как `n_ctx_seq * n_seq_max` с warning `n_ctx is not divisible by n_seq_max - rounding down to %u`. С unified KV `n_ctx_seq = n_ctx`, а KV-cache использует один stream для всех sequences.

В логах `llama-context` смотрите `kv_unified = true/false`, а в `llama-kv-cache` строку с количеством seqs/streams.

## Значения и формат

CLI-форма флаговая:

- `--kv-unified`: включить.
- `--no-kv-unified`: выключить; в auto-режиме (`n_parallel < 0`) игнорируется.

Значение по умолчанию `common_params::kv_unified = false`, поэтому при явном `--parallel N` unified KV выключен, пока флаг не задан.

## Когда использовать

Используйте для многослотового сервера, где запросы имеют разную длину и статическое деление контекста по слотам слишком жесткое. С `--cache-idle-slots` это дополнительно позволяет очищать KV idle slots после сохранения в prompt cache.

Отключайте для более простой модели памяти или если backend/модель ведет себя нестабильно с unified KV.

## Влияние на производительность и память

Unified KV уменьшает потери от пустых слотов и позволяет длинному активному запросу использовать общий контекст. Но конкурирующие длинные запросы начинают делить один ресурс, поэтому возрастает роль `--cache-ram` и очистки idle slots.

## Взаимодействие с другими аргументами

- `--parallel -1` (и любое отрицательное значение): автоматически включает этот режим. Принудительное включение в `server.cpp` выполняется после парсинга аргументов и безусловно ставит `kv_unified = true`, поэтому комбинация `--parallel -1 --no-kv-unified` молча игнорирует выключение.
- `--ctx-size`: становится размером общего KV-буфера.
- `--cache-idle-slots`: работает и без unified KV, но очищает KV idle slots только при `--kv-unified`.
- `--cache-ram`: нужен для сохранения idle slots перед очисткой.
- `--cache-type-k` и `--cache-type-v`: определяют типы данных внутри unified KV.

## INI-пресеты и router-режим

В INI используйте `kv-unified = true` или `no-kv-unified = true`. В router-режиме применяется в дочернем процессе модели.

## Типовые проблемы и диагностика

- Если запросы вытесняют друг друга из KV, смотрите логи `purging slot ...` и состояние prompt cache. Лог `purging slot %d with %zu tokens` пишет `try_clear_idle_slots`, который без `--kv-unified` сразу возвращает `false` — вытеснение idle-слотов работает только в unified-режиме.
- Если ожидаете auto unified, проверьте лог `n_parallel is set to auto`.
- Контекст слота капится training-контекстом модели: `n_ctx_slot = llama_n_ctx_seq(ctx)`, при превышении сервер пишет warning `the slot context (%d) exceeds the training context of the model (%d) - capping`, и лог `new slot, n_ctx = ...` покажет меньше, чем `--ctx-size`.

## Примеры

```bash
llama-server --model /models/model.gguf --parallel 4 --kv-unified --ctx-size 65536
```

```bash
llama-server --model /models/model.gguf --parallel 4 --no-kv-unified --ctx-size 32768
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
