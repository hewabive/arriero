---
schema: 1
primaryName: "--spec-default"
title: "--spec-default"
summary: "Включает встроенную ngram-mod speculative конфигурацию: match 24, min 48, max 64. Draft-модель этот флаг не задает."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--spec-default"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-ngram-mod-n-match"
  - "--spec-ngram-mod-n-min"
  - "--spec-ngram-mod-n-max"
  - "--spec-draft-model"
  - "--spec-draft-hf"
---

# --spec-default

## Кратко

`--spec-default` включает default speculative decoding config из llama.cpp. На проверенном commit это ngram-mod конфигурация без draft-модели.

## Оригинальная справка llama.cpp

```text
enable default speculative decoding config
```

## Паспорт аргумента

- Основное имя: `--spec-default`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до инициализации speculative subsystem
- Область: `llama-server`, `llama-cli`

## Что меняет в llama-server

Флаг выполняет:

- добавляет `COMMON_SPECULATIVE_TYPE_NGRAM_MOD` в `params.speculative.types`;
- задает `params.speculative.ngram_mod.n_match = 24`;
- задает `params.speculative.ngram_mod.n_min = 48`;
- задает `params.speculative.ngram_mod.n_max = 64`.

Draft-модель, `--spec-draft-hf` и `--spec-draft-model` этот флаг не задает.

## Значения и формат

```bash
llama-server --model /srv/models/model.gguf --spec-default
```

INI:

```ini
[fast-local]
model = /srv/models/model.gguf
spec-default = true
```

## Когда использовать

Используйте как быстрый способ включить ngram-based speculative decoding без отдельной draft-модели. Это может помочь на workloads с повторяющимися фрагментами или предсказуемыми продолжениями.

Не считайте флаг универсальным ускорителем: эффективность зависит от prompt pattern, модели, batch/parallel режима и backend.

## Влияние на производительность и память

Ngram speculative decoding не требует второй модели, но `ngram-mod` создает один общий массив из 4,194,304 token entries: ровно 16 MiB host RAM в текущем llama.cpp. Arriero включает его в постоянный overhead. Дополнительно растут структуры истории запроса; на неподходящем workload ускорения может не быть.

Параметры `n_match = 24`, `n_min = 48`, `n_max = 64` задают окно совпадений и диапазон предлагаемых ngram tokens для ngram-mod реализации.

## Взаимодействие с другими аргументами

`--spec-type` вручную добавляет speculative types. Default `params.speculative.types` содержит `none`; `--spec-default` добавляет к списку `ngram-mod`, и speculative init игнорирует `none` как активную реализацию.

Ручные аргументы `--spec-ngram-mod-n-match`, `--spec-ngram-mod-n-min`, `--spec-ngram-mod-n-max` управляют теми же полями, что и `--spec-default`. В CLI порядок аргументов важен: более поздний обработчик перезапишет поле.

С `--fim-qwen-7b-spec` или `--fim-qwen-14b-spec` этот флаг может добавить ngram-mod поверх draft setup. Проверяйте фактическую скорость и логи, потому что несколько speculative методов не всегда лучше одного.

## INI-пресеты и router-режим

В router INI:

```ini
[model-with-ngram-spec]
model = /srv/models/model.gguf
spec-default = true
alias = fast-model
```

Если нужны точные значения ngram-mod в INI, надежнее записать `spec-type = ngram-mod` и явные `spec-ngram-mod-*` ключи вместо shortcut.

## Типовые проблемы и диагностика

- Нет ускорения: workload плохо подходит для ngram speculative decoding.
- Ошибка инициализации speculative context: ищите лог `failed to initialize speculative decoding context`.
- Ручные `spec-ngram-mod-*` не дали ожидаемый эффект: проверьте порядок CLI аргументов или разверните shortcut в явные ключи.
- Ожидали draft-модель: используйте `--spec-draft-model`/`--spec-draft-hf` или Qwen `*-spec` shortcut.

## Примеры

```bash
llama-server --model /srv/models/model.gguf --spec-default
```

```bash
llama-server --model /srv/models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-match 24 --spec-ngram-mod-n-min 48 --spec-ngram-mod-n-max 64
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--spec-default`, `--spec-type`, `--spec-ngram-mod-*`.
- `llama.cpp/common/common.h`: default speculative type list.
- `llama.cpp/common/speculative.cpp`: selection of active speculative configs.
- `llama.cpp/tools/server/README.md`: help `--spec-default`.
