---
schema: 1
primaryName: "--spec-ngram-simple-min-hits"
title: "--spec-ngram-simple-min-hits"
summary: "Параметр парсится в `common_params.speculative.ngram_simple.min_hits`, но в текущем commit не влияет на алгоритм `ngram-simple`: runtime config передает только `size_n` и `size_m`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-simple-min-hits"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-simple-size-n"
  - "--spec-ngram-simple-size-m"
  - "--spec-ngram-map-k4v-min-hits"
---

# --spec-ngram-simple-min-hits

## Кратко

`--spec-ngram-simple-min-hits` существует в CLI и проходит проверку значения, но в проверенном commit `751ebd17a58a8a513994509214373bb9e6a3d66c` не используется при генерации `ngram-simple` drafts.

Причина в коде: `params.speculative.ngram_simple.min_hits` сохраняется и печатается в логе инициализации, но `common_ngram_simple_config` содержит только `size_ngram` и `size_mgram`; функция `common_ngram_simple_draft()` не получает `min_hits`.

## Оригинальная справка llama.cpp

```text
minimum hits for ngram-simple speculative decoding (default: 1)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-simple-min-hits`
- Алиасы: нет
- Значение по умолчанию: `1`
- CLI-ограничение: значение должно быть `>= 1`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_simple.min_hits`
- Фактическое runtime-влияние в текущем commit: отсутствует для `ngram-simple`

## Что меняет в llama-server

На этапе парсинга аргумент меняет поле конфигурации и отображается в логе `adding speculative implementation 'ngram-simple'` строкой `min_hits=...`. Дальше это значение не участвует в поиске совпадения и не меняет, будет ли создан draft.

## Значения и формат

- Значения меньше `1` отклоняются с ошибкой `ngram min hits must be at least 1`.
- Верхний предел в CLI-парсере не задан, но поле имеет тип `uint16_t`; не используйте значения выше `65535`.
- Поскольку параметр не влияет на текущий `ngram-simple`, менять его для настройки качества бесполезно.

## Когда использовать

Для текущего `llama-server` не используйте этот параметр как tuning knob. Для порога повторяемости используйте `ngram-map-k4v` и `--spec-ngram-map-k4v-min-hits`, где проверка реально есть.

## Влияние на производительность и память

В текущей реализации влияния нет: ни память, ни число черновиков `ngram-simple` от этого значения не меняются.

## Взаимодействие с другими аргументами

- `--spec-ngram-simple-size-n` и `--spec-ngram-simple-size-m` реально управляют `ngram-simple`.
- `--spec-type ngram-simple` нужен для запуска реализации.
- `--spec-ngram-map-k-min-hits` тоже не применяется к draft decision в ветке `ngram-map-k` текущего кода; `--spec-ngram-map-k4v-min-hits` применяется.

## INI-пресеты и router-режим

Ключ можно записать в preset как `spec-ngram-simple-min-hits = 2`, но это только изменит сохраненное значение и лог. Практического эффекта на `ngram-simple` в текущем commit нет.

## Типовые проблемы и диагностика

- Если изменение этого параметра не меняет количество drafts, это ожидаемое поведение текущего кода.
- Для проверки смотрите исходники `common_speculative_impl_ngram_simple` и `common_ngram_simple_config`.
- Не используйте этот аргумент для публичной документации как рабочий фильтр качества без повторной сверки с новым commit llama.cpp.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-simple --spec-ngram-simple-size-n 12 --spec-ngram-simple-size-m 48
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.h`
- `llama.cpp/common/ngram-map.cpp`
