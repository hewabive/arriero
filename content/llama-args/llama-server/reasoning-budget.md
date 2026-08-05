---
schema: 1
primaryName: "--reasoning-budget"
title: "--reasoning-budget"
summary: "Ограничивает число токенов внутри thinking block. `-1` оставляет reasoning без лимита, `0` принудительно завершает block сразу после start tag, положительное `N` задает бюджет."
category: "Параметры llama-server"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--reasoning-budget"
allowedValues: []
env:
  - "LLAMA_ARG_THINK_BUDGET"
related:
  - "--reasoning"
  - "--reasoning-format"
  - "--reasoning-budget-message"
  - "--jinja"
---

# --reasoning-budget

## Кратко

`--reasoning-budget` записывает `common_params::sampling.reasoning_budget_tokens`. Значение применяется sampler-ом reasoning budget, который начинает считать токены после thinking start tag и при исчерпании форсирует `reasoning_budget_message + end tag`.

Бюджет работает только когда chat template дал thinking start/end tags. Для обычного completion без thinking tags он не ограничивает весь ответ.

## Оригинальная справка llama.cpp

```text
token budget for thinking: -1 for unrestricted, 0 for immediate end, N>0 for token budget (default: -1)
```

## Паспорт аргумента

- Основное имя: `--reasoning-budget`
- Значение: integer `N`
- Поле `common_params`: `sampling.reasoning_budget_tokens`
- Допустимый минимум: `-1`; значения меньше `-1` отклоняются как `invalid value`
- Переменная окружения: `LLAMA_ARG_THINK_BUDGET`
- По умолчанию: `-1`

## Что меняет в llama-server

При chat request server-common передает в task `reasoning_budget_tokens`, `reasoning_budget_start_tag`, `reasoning_budget_end_tag` и `reasoning_budget_message`, если template вернул `thinking_end_tag`. В `server-task.cpp` start/end/message токенизируются с `parse_special=true`.

В sampling chain `common_reasoning_budget_init()` добавляется, если есть start/end токены и либо бюджет неотрицательный, либо включена lazy grammar. При бюджете `0` sampler сразу переходит к forced end sequence после активации.

## Значения и формат

- `-1`: unrestricted; budget sampler не ограничивает длину thinking, кроме случаев lazy grammar.
- `0`: завершить thinking block сразу после start sequence.
- `N > 0`: разрешить до `N` generated tokens внутри reasoning block.

Клиент может переопределить неограниченный CLI default через request field `thinking_budget_tokens`, если CLI значение осталось `-1`.

## Когда использовать

- Нужно ограничить latency reasoning-моделей на публичном или shared server.
- Нужно оставить thinking включенным, но не позволять ему занимать весь контекст.
- Нужно быстро проверить, как модель отвечает без длинной chain-of-thought: `--reasoning-budget 0`.

## Влияние на производительность и память

Меньший budget снижает число generated tokens, latency и занятость слота. На размер KV-cache напрямую не влияет, но меньше reasoning tokens означает меньше фактически записанных KV entries. Слишком маленький budget может ухудшить качество ответа, если модель ожидает reasoning перед финальным ответом.

## Взаимодействие с другими аргументами

- `--reasoning`: должен разрешать thinking, иначе budget может не активироваться.
- `--reasoning-budget-message`: добавляется перед end tag при исчерпании.
- `--reasoning-format`: влияет на то, где клиент увидит forced end/message.
- `--jinja` и `--chat-template`: нужны корректные thinking start/end tags.
- Backend sampling несовместим с reasoning budget; sampling code отключает backend sampling с warning.

## INI-пресеты и router-режим

В INI пишите `reasoning-budget = 256` или `reasoning-budget = 0`. В router mode задавайте per-model: у reasoning и non-reasoning моделей разный смысл этой настройки.

## Типовые проблемы и диагностика

- Бюджет не срабатывает: в template нет thinking tags или reasoning выключен.
- В логах `reasoning-budget: activated`: sampler увидел start tag и начал считать.
- В логах `reasoning-budget: budget exhausted, forcing end sequence`: budget исчерпан.
- Ошибка на старте `invalid value`: передано число меньше `-1`.

## Примеры

```bash
llama-server --model /models/reasoning.gguf --reasoning on --reasoning-budget 256
```

```bash
llama-server --model /models/reasoning.gguf --reasoning on --reasoning-budget 0
```

## Источники

- `llama.cpp/common/arg.cpp`: validation и env `LLAMA_ARG_THINK_BUDGET`.
- `llama.cpp/tools/server/server-common.cpp`: передача budget в task.
- `llama.cpp/tools/server/server-task.cpp`: токенизация start/end/forced sequence.
- `llama.cpp/common/reasoning-budget.cpp`: состояние sampler.
- `llama.cpp/common/sampling.cpp`: подключение sampler и warning про backend sampling.
