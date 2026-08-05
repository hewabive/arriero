---
schema: 1
primaryName: "--context-shift"
title: "--context-shift"
summary: "Разрешает сдвиг контекста при бесконечной генерации, чтобы не останавливаться на заполнении `n_ctx`. По умолчанию выключено."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--context-shift"
  - "--no-context-shift"
allowedValues: []
env:
  - "LLAMA_ARG_CONTEXT_SHIFT"
related:
  - "--keep"
  - "--ctx-size"
  - "--predict"
  - "--cache-reuse"
---

# --context-shift

## Кратко

`--context-shift` задает `common_params::ctx_shift`: разрешить удаление части старого контекста и сдвиг оставшихся KV-позиций, когда генерация подходит к лимиту слота.

По умолчанию в server-справке disabled.

## Оригинальная справка llama.cpp

```text
whether to use context shift on infinite text generation (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--context-shift`
- Алиасы: `--context-shift`, `--no-context-shift`
- Значение по умолчанию: disabled
- Переменная окружения: `LLAMA_ARG_CONTEXT_SHIFT`
- Поле llama.cpp: `common_params::ctx_shift`
- Этап применения: генерация в `update_slots()`

## Что меняет в llama-server

Когда `slot.prompt.n_tokens() + 1 >= slot.n_ctx`, сервер с включенным context shift оставляет первые `n_keep` токенов, удаляет `n_discard` токенов после них и сдвигает оставшийся KV назад.

Если context shift выключен, генерация останавливается с `STOP_TYPE_LIMIT` и response получает `truncated = true`.

## Значения и формат

- `--context-shift`: включить.
- `--no-context-shift`: выключить.

Если memory type не поддерживает shifting или загружен multimodal projector, сервер автоматически отключает режим и пишет warning.

## Когда использовать

Включайте для long-running text generation, где допустимо забывать середину/старый контекст. Не включайте для строгих chat/RAG сценариев, где потеря старых токенов меняет смысл.

## Влияние на производительность и память

Не увеличивает KV-size, а позволяет продолжать генерацию в фиксированном окне. Сам shift требует операций удаления/сдвига KV, но дешевле полного перезапуска.

## Взаимодействие с другими аргументами

- `--keep`: сколько initial prompt tokens сохранить при shift.
- `n_discard` в HTTP `/completion`: сколько токенов выбросить; если `0`, сервер выбрасывает половину оставшейся части.
- `--cache-reuse`: также требует memory shifting.
- `--predict -1`: без context shift бесконечная генерация все равно упрется в `n_ctx`.
- Multimodal (`--mmproj`) отключает `ctx_shift`.

## INI-пресеты и router-режим

В INI используйте `context-shift = true` или `no-context-shift = true`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- Warning `ctx_shift is not supported by multimodal` означает автоматическое отключение.
- Лог `slot context shift, n_keep = ..., n_left = ..., n_discard = ...` показывает фактический shift.
- Если ответ обрывается по лимиту, проверьте `truncated`, `stop`, `n_ctx` и включен ли `--context-shift`.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 4096 --context-shift --keep 128 --predict -1
```

```bash
llama-server --model /models/model.gguf --no-context-shift --predict 512
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/tests/unit/test_ctx_shift.py`
