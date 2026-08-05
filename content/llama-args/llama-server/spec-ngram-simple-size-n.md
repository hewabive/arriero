---
schema: 1
primaryName: "--spec-ngram-simple-size-n"
title: "--spec-ngram-simple-size-n"
summary: "Размер n-gram ключа для `ngram-simple`: сколько последних токенов используется для поиска предыдущего совпадения в истории. Работает только при включенном `--spec-type ngram-simple`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-simple-size-n"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-simple-size-m"
  - "--spec-ngram-simple-min-hits"
  - "--spec-ngram-map-k-size-n"
  - "--spec-ngram-map-k4v-size-n"
---

# --spec-ngram-simple-size-n

## Кратко

`--spec-ngram-simple-size-n` задает длину n-gram pattern для `ngram-simple`. Реализация берет последние `N - 1` токенов из истории, добавляет только что sampled токен и ищет такое же окно назад по текущей token history. Если совпадение найдено, сервер предлагает следующие `--spec-ngram-simple-size-m` токенов как speculative draft.

## Оригинальная справка llama.cpp

```text
ngram size N for ngram-simple speculative decoding, length of lookup n-gram (default: 12)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-simple-size-n`
- Алиасы: нет
- Значение по умолчанию: `12`
- Допустимый диапазон: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_simple.size_n`
- Runtime config: `common_ngram_simple_config.size_ngram`
- Применяется: при создании speculative context; не меняется через HTTP request body

## Что меняет в llama-server

`ngram-simple` не использует draft model, KV-cache отдельной модели или embeddings. Он ищет повтор в уже имеющейся истории токенов текущего слота. Чем больше `size_n`, тем специфичнее совпадение и тем реже будут черновики; чем меньше `size_n`, тем больше риск неверных продолжений.

Для генерации черновика текущая история должна быть длиннее `size_n + size_m + 1`, иначе алгоритм сразу возвращает пустой draft.

## Значения и формат

- `1..1024` принимаются.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size N must be between 1 and 1024 inclusive`.
- Это размер в токенах, а не в символах или словах.

## Когда использовать

Используйте `ngram-simple` для редактирования, переписывания и генерации с длинными локальными повторами, где продолжение уже встречалось в текущем контексте. Для общих chat-запросов без повторов эффект обычно слабый.

## Влияние на производительность и память

Память почти не меняется: `ngram-simple` выполняет поиск по истории и не хранит крупную карту. Слишком малое `size_n` может увеличить число неудачных speculative проверок, слишком большое - почти отключить черновики из-за редких совпадений.

## Взаимодействие с другими аргументами

- `--spec-type ngram-simple` включает этот вариант.
- `--spec-ngram-simple-size-m` задает максимальную длину копируемого продолжения.
- `--spec-ngram-simple-min-hits` в текущем commit парсится и логируется, но не участвует в `common_ngram_simple_draft`.
- `--spec-draft-n-max` и доступный контекст могут обрезать итоговый draft после его построения.
- Удаленный `--spec-ngram-size-n` больше не задает общий размер; используйте variant-specific аргументы.

## INI-пресеты и router-режим

```ini
spec-type = ngram-simple
spec-ngram-simple-size-n = 12
spec-ngram-simple-size-m = 48
```

Ключ поддерживается в `--models-preset` без ведущих дефисов. Router не перезаписывает его.

## Типовые проблемы и диагностика

- В логах нет `adding speculative implementation 'ngram-simple'`: не включен `--spec-type ngram-simple`.
- Черновиков нет на коротком prompt: истории должно хватать минимум на lookup и копируемый m-gram.
- Смотрите `statistics ngram_simple: #gen drafts ... #gen tokens ... #acc tokens ...` в финальной статистике запроса.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-simple --spec-ngram-simple-size-n 12 --spec-ngram-simple-size-m 48
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.cpp`
- `llama.cpp/docs/speculative.md`
