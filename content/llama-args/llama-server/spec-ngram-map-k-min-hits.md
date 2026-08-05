---
schema: 1
primaryName: "--spec-ngram-map-k-min-hits"
title: "--spec-ngram-map-k-min-hits"
summary: "Параметр сохраняется в конфигурации `ngram-map-k`, но в текущем коде не фильтрует drafts: ветка `key_only` создает draft до проверки `min_hits`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-map-k-min-hits"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-map-k-size-n"
  - "--spec-ngram-map-k-size-m"
  - "--spec-ngram-map-k4v-min-hits"
---

# --spec-ngram-map-k-min-hits

## Кратко

`--spec-ngram-map-k-min-hits` объявлен как minimum hits для `ngram-map-k`, но в проверенном commit фактически не влияет на решение о создании draft. `get_common_ngram_map()` передает значение в `common_ngram_map.min_hits`, однако для `ngram-map-k` выставляется `key_only=true`, а `common_ngram_map_draft()` возвращает draft до блока `if (curr_key.key_num < map.min_hits)`.

## Оригинальная справка llama.cpp

```text
minimum hits for ngram-map-k speculative decoding (default: 1)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-map-k-min-hits`
- Алиасы: нет
- Значение по умолчанию: `1`
- CLI-ограничение: значение должно быть `>= 1`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_map_k.min_hits`
- Фактическое runtime-влияние для `ngram-map-k`: отсутствует в текущем commit

## Что меняет в llama-server

Аргумент меняет сохраненную конфигурацию и значение в логе инициализации `size_key=..., size_value=..., key_only=1, min_hits=...`. Но текущая `key_only` ветка использует найденный key сразу и не проверяет порог.

## Значения и формат

- Значения меньше `1` отклоняются с ошибкой `ngram min hits must be at least 1`.
- Верхний предел в CLI не задан, но внутренний тип `uint16_t`; держите значение в диапазоне `1..65535`.
- Для рабочего порога повторяемости используйте `--spec-ngram-map-k4v-min-hits`.

## Когда использовать

В текущем `llama-server` не используйте этот аргумент как tuning knob. Настраивайте `--spec-ngram-map-k-size-n` и `--spec-ngram-map-k-size-m` либо переходите на `ngram-map-k4v`, где `min_hits` проверяется.

## Влияние на производительность и память

Влияния на `ngram-map-k` drafts нет. Меняется только поле конфигурации и лог.

## Взаимодействие с другими аргументами

- `--spec-type ngram-map-k` включает реализацию.
- `--spec-ngram-map-k-size-n` и `--spec-ngram-map-k-size-m` реально влияют на поиск и длину draft.
- `--spec-ngram-map-k4v-min-hits` применяет похожий порог в варианте `key4v`.

## INI-пресеты и router-режим

Ключ `spec-ngram-map-k-min-hits = 2` допустим в preset, но в текущем commit не изменит поведение `ngram-map-k`.

## Типовые проблемы и диагностика

- Если изменение `min_hits` не меняет число drafts, это соответствует коду.
- Подтвердить можно по `common_ngram_map_draft()`: ветка `if (map.key_only)` находится выше проверки `map.min_hits`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-map-k --spec-ngram-map-k-size-n 12 --spec-ngram-map-k-size-m 48
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-map.h`
- `llama.cpp/common/ngram-map.cpp`
