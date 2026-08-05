---
schema: 1
primaryName: "--spec-draft-p-split"
title: "--spec-draft-p-split"
summary: "Записывает split probability draft speculative decoding в `common_params.speculative.draft.p_split`. В проверенном commit значение парсится и хранится, но не используется в активной server/speculative логике."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "P"
aliases:
  - "--spec-draft-p-split"
  - "--draft-p-split"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_P_SPLIT"
related:
  - "--spec-draft-p-min"
  - "--spec-draft-n-max"
  - "--spec-type"
  - "--spec-draft-model"
---

# --spec-draft-p-split

## Кратко

`--spec-draft-p-split` парсит float-значение и записывает его в `common_params.speculative.draft.p_split`. Значение по умолчанию - `0.10`.

В commit `751ebd17a58a8a513994509214373bb9e6a3d66c` поле `p_split` объявлено и заполняется, но поиск по `common/speculative.cpp`, `tools/server/server-context.cpp` и `tools/server/server-task.cpp` не показывает активного использования этого поля. Поэтому менять параметр для production-тюнинга сейчас не имеет подтвержденного эффекта на server runtime.

## Оригинальная справка llama.cpp

```text
speculative decoding split probability (default: 0.10)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-p-split`
- Алиасы: `--spec-draft-p-split`, `--draft-p-split`
- Значение: float-строка, парсится через `std::stof()`
- Структура llama.cpp: `common_params.speculative.draft.p_split`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_P_SPLIT`
- Значение по умолчанию: `0.10`
- Подтвержденное применение в server runtime: не найдено в проверенном commit

## Что меняет в llama-server

На этапе парсинга аргумент меняет поле `p_split`. Дальше server-context при загрузке draft-модели копирует другие draft параметры вроде модели, устройств, KV-cache и tensor overrides, но активная speculative draft логика использует `n_max`, `n_min`, `p_min` и `backend_sampling`; `p_split` там не читается.

Это может быть задел под экспериментальную/будущую реализацию, но текущая справка должна считать его stored-only параметром.

## Значения и формат

Практически указывайте число с точкой: `0.10`, `0.25`. Код не валидирует диапазон, но как probability значение должно быть в диапазоне `0.0` до `1.0`.

## Когда использовать

Используйте только для совместимости с конфигурациями или экспериментов при сверке с конкретной веткой llama.cpp. Для реального тюнинга текущего server используйте `--spec-draft-p-min`, `--spec-draft-n-max` и `--spec-draft-n-min`.

## Влияние на производительность и память

В проверенном server runtime влияния не найдено. Память, VRAM, acceptance и latency не должны меняться от одного этого аргумента, пока downstream-код не начнет читать `p_split`.

## Взаимодействие с другими аргументами

Связан концептуально с `--spec-draft-p-min`, но фактически `p_min` используется в draft loop, а `p_split` нет. Если после обновления llama.cpp поле начнет использоваться, нужно заново проверить взаимодействие с `--spec-draft-backend-sampling` и MTP/draft-simple реализациями.

## INI-пресеты и router-режим

В INI возможны `spec-draft-p-split = 0.10` или `draft-p-split = 0.10`, но для текущего commit это не дает подтвержденного runtime-эффекта. Не добавляйте в preset без причины.

## Типовые проблемы и диагностика

- "Я поменял `p_split`, но ничего не изменилось": это ожидаемо для проверенного commit, поле не используется активной speculative логикой server.
- Ошибка парсинга: значение не распознается `std::stof()`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-p-split 0.10
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-task.cpp`
