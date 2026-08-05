---
schema: 1
primaryName: "--keep"
title: "--keep"
summary: "Default для `n_keep`: сколько токенов начального prompt сохранять при context shift. `-1` означает сохранить весь prompt."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--keep"
allowedValues: []
env: []
related:
  - "--context-shift"
  - "--ctx-size"
  - "--predict"
---

# --keep

## Кратко

`--keep` задает `common_params::n_keep`, затем default `task_params::n_keep`: сколько токенов начального prompt сохранять при context shift.

В HTTP `/completion` это значение можно переопределить параметром `n_keep`.

## Оригинальная справка llama.cpp

```text
number of tokens to keep from the initial prompt (default: 0, -1 = all)
```

## Паспорт аргумента

- Основное имя: `--keep`
- Значение по умолчанию: `0`
- Специальное значение: `-1` сохранить весь prompt
- Переменная окружения: нет
- Поле llama.cpp: `common_params::n_keep`, затем `task_params::n_keep`
- Этап применения: context shift во время генерации

## Что меняет в llama-server

При context shift сервер считает `n_keep = task.n_tokens()` для `-1`, иначе берет заданное число. Если tokenizer добавляет BOS, к `n_keep` добавляется 1. Затем значение ограничивается `slot.n_ctx - 4`.

После этого сервер выбрасывает `n_discard` токенов после сохраненной части и сдвигает оставшийся KV.

## Значения и формат

- `0`: не сохранять специальных initial prompt tokens, кроме внутренней BOS-коррекции.
- Положительное число: сохранить столько токенов prompt.
- `-1`: сохранить весь исходный prompt, насколько позволяет `n_ctx - 4`.

## Когда использовать

Используйте для long-running generation с `--context-shift`, чтобы сохранить system prompt, инструкцию или prefix. Для обычных bounded запросов без context shift параметр почти не влияет.

## Влияние на производительность и память

Большой `--keep` уменьшает пространство, которое остается для новых токенов после shift, и может чаще вызывать shifts. Маленький `--keep` освобождает больше окна, но быстрее забывает начальные инструкции.

## Взаимодействие с другими аргументами

- `--context-shift`: основной потребитель `--keep`.
- `--ctx-size`: ограничивает максимум `n_keep` через `slot.n_ctx - 4`.
- `--predict`: при коротком лимите генерации context shift может не наступить.
- HTTP `n_discard`: управляет числом выбрасываемых токенов после `n_keep`.

## INI-пресеты и router-режим

У `--keep` нет env-переменной, но INI parser распознает ключ `keep`, потому что mapping строится и по именам CLI-аргументов. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- Лог `slot context shift, n_keep = ...` показывает фактическое значение после BOS-коррекции и ограничения.
- Если модель забывает system prompt при бесконечной генерации, увеличьте `--keep`.
- Если shift происходит слишком часто, уменьшите `--keep` или увеличьте `--ctx-size`.

## Примеры

```bash
llama-server --model /models/model.gguf --context-shift --keep 256 --predict -1
```

```bash
llama-server --model /models/model.gguf --context-shift --keep -1 --ctx-size 8192
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
