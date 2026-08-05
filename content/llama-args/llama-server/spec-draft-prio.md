---
schema: 1
primaryName: "--spec-draft-prio"
title: "--spec-draft-prio"
summary: "Задает scheduler priority для generation CPU-профиля draft-модели: `0` normal, `1` medium, `2` high, `3` realtime. В отличие от основного `--prio`, значение `-1` здесь запрещено."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--prio-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-threads"
  - "--spec-draft-poll"
  - "--prio"
  - "--poll"
---

# --spec-draft-prio

## Кратко

`--spec-draft-prio` задает scheduler priority для CPU worker-профиля draft-модели. Это не приоритет HTTP-запросов и не порядок speculative implementations; параметр относится к CPU scheduling.

## Оригинальная справка llama.cpp

```text
set draft process/thread priority : 0-normal, 1-medium, 2-high, 3-realtime (default: 0)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-prio`
- Алиасы: `--prio-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `0`

## Что меняет в llama-server

CLI-обработчик проверяет диапазон `0..3` и записывает enum `ggml_sched_priority` в `params.speculative.draft.cpuparams.priority`. Значения вне диапазона вызывают `invalid value`.

Для ggml threadpool priority переносится через `ggml_threadpool_params.prio`, а CPU backend применяет его через platform-specific API. Но в проверенном `server-context.cpp` draft-модель получает из draft CPU-профиля только `n_threads`; `priority` не копируется явно в `params_dft.cpuparams`. Поэтому в `llama-server` на commit `751ebd17...` draft-specific priority следует считать parsed/stored параметром с неподтвержденным применением в draft runtime.

## Значения и формат

Допустимы только `0` normal, `1` medium, `2` high, `3` realtime. `-1` low разрешен основным `--prio`, но запрещен для `--spec-draft-prio` и `--spec-draft-prio-batch`.

## Когда использовать

Используйте только на выделенных inference-хостах после измерений. Повышение priority draft-модели может снизить время генерации кандидатов, но легко ухудшит target verification, HTTP handling и общую отзывчивость машины. На shared VM и desktop обычно оставляйте `0`.

## Влияние на производительность и память

Память не меняется. Priority не ускоряет вычисления, а только влияет на конкуренцию за CPU. На Linux `medium`, `high` и `realtime` используют realtime scheduling policy в ggml CPU backend и могут требовать привилегий; без прав возможны предупреждения `failed to set thread priority`.

## Взаимодействие с другими аргументами

- `--spec-draft-poll` вместе с высоким priority может агрессивно занимать CPU.
- `--spec-draft-threads` определяет, сколько worker threads будет конкурировать с target и HTTP.
- `--prio` задает основной CPU-профиль и может быть более надежным способом изменить scheduling всего server path.
- `--spec-draft-prio-batch` относится к batch/prompt CPU-профилю draft.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `prio-draft = 1`. Router не удаляет этот параметр из дочернего argv. Для публичного сервера не задавайте `prio-draft = 3` без отдельного контроля CPU/cgroup.

## Типовые проблемы и диагностика

- `invalid value` при старте означает число вне диапазона `0..3`.
- `failed to set thread priority` означает, что ОС не разрешила выбранный scheduler priority.
- Если `prio-draft` не дает эффекта, проверьте ограничение `server-context.cpp`: draft-specific priority может не переноситься в draft runtime.
- При росте latency target-модели уменьшите `--spec-draft-prio` или отключите draft polling.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-prio 1
```

```ini
[*]
model-draft = /models/draft.gguf
prio-draft = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление, диапазон `0..3` и запись в `params.speculative.draft.cpuparams.priority`.
- `llama.cpp/common/common.h` - enum/поле CPU priority.
- `llama.cpp/common/common.cpp` - перенос CPU params в ggml threadpool params.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и ограничение копирования draft CPU-профиля.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - platform-specific thread priority.
- `llama.cpp/tools/server/README.md` - help-строка.
