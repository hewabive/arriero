---
schema: 1
primaryName: "--spec-draft-p-min"
title: "--spec-draft-p-min"
summary: "Задает минимальную вероятность top draft-кандидата для greedy draft-model/MTP speculative decoding. Чем выше порог, тем короче и надежнее draft."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "P"
aliases:
  - "--spec-draft-p-min"
  - "--draft-p-min"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_P_MIN"
related:
  - "--spec-draft-n-max"
  - "--spec-draft-n-min"
  - "--spec-draft-p-split"
  - "--spec-type"
  - "--spec-draft-backend-sampling"
---

# --spec-draft-p-min

## Кратко

`--spec-draft-p-min` задает `common_params.speculative.draft.p_min`: минимальную probability top-кандидата draft sampler. Если `cur_p->data[0].p < p_min`, draft generation для последовательности останавливается.

По умолчанию `0.00`, то есть порог confidence фактически не ограничивает draft.

## Оригинальная справка llama.cpp

```text
minimum speculative decoding probability (greedy) (default: 0.00)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-p-min`
- Алиасы: `--spec-draft-p-min`, `--draft-p-min`
- Значение: float-строка, парсится через `std::stof()`
- Структура llama.cpp: `common_params.speculative.draft.p_min`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_P_MIN`
- Значение по умолчанию: `0.00`

## Что меняет в llama-server

В `draft-simple` и `draft-mtp` draft sampler выбирает top token и смотрит его probability. Если probability ниже порога, текущий draft прекращается; уже набранные токены затем проходят проверку `--spec-draft-n-min`.

Этот параметр влияет на draft generation, а не на acceptance target-моделью. Target все равно подтверждает draft через основной sampler.

## Значения и формат

Практический диапазон - `0.0` до `1.0`. Код не ограничивает диапазон явно: отрицательные значения будут принимать почти все top-кандидаты, значения выше `1.0` фактически остановят draft до добавления токенов.

Используйте точку как десятичный разделитель: `0.75`, `0.9`.

## Когда использовать

Повышайте `p_min`, если draft генерирует много неверных токенов и acceptance низкая. Понижайте, если draft часто обрывается слишком рано и `n_min` отбрасывает результаты.

## Влияние на производительность и память

Память не меняется. Производительность меняется через длину и качество draft: высокий `p_min` уменьшает wasted verification, но может не давать достаточно длинных draft; низкий `p_min` дает длиннее draft, но повышает риск отклонения target-моделью.

## Взаимодействие с другими аргументами

`--spec-draft-n-max` задает потолок длины, а `p_min` часто задает фактическую остановку раньше потолка. `--spec-draft-n-min` может очистить draft, если высокий `p_min` оставил слишком мало токенов. `--spec-draft-backend-sampling` для MTP может переносить top-k sampling draft на backend, но логика порога остается связана с candidates probability.

## INI-пресеты и router-режим

В INI используйте `spec-draft-p-min = 0.75` или `draft-p-min = 0.75`. Runtime-поле `speculative.p_min` в `server-task.cpp` сейчас неактивно, поэтому меняйте значение через конфигурацию запуска.

## Типовые проблемы и диагностика

- Draft почти не создается: `p_min` слишком высокий или draft-модель не уверена.
- Acceptance низкая при длинных draft: поднимите `p_min` или уменьшите `--spec-draft-n-max`.
- Значение из HTTP request не действует: speculative runtime adjustment отключен.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-p-min 0.75
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-task.cpp`
