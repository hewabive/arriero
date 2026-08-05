---
schema: 1
primaryName: "--spec-draft-cpu-strict"
title: "--spec-draft-cpu-strict"
summary: "Переключает strict CPU placement для generation-профиля draft-модели: `0` дает каждому worker всю affinity mask, `1` раскладывает workers по CPU из mask. В текущем server load path draft strict flag парсится, но не копируется явно в draft runtime."
category: "Параметры speculative decoding"
valueType: "boolean"
estimation: "normal"
valueHint: "<0|1>"
aliases:
  - "--cpu-strict-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-cpu-mask"
  - "--spec-draft-cpu-range"
  - "--spec-draft-threads"
  - "--cpu-strict"
---

# --spec-draft-cpu-strict

## Кратко

`--spec-draft-cpu-strict` задает strict placement для CPU affinity draft generation-профиля. Он имеет смысл только вместе с draft affinity mask/range: без заданной mask CPU backend не получает набора CPU, который можно распределять.

## Оригинальная справка llama.cpp

```text
Use strict CPU placement for draft model (default: same as --cpu-strict)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-cpu-strict`
- Алиасы: `--cpu-strict-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `boolean`
- Подсказка формата: `<0|1>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --cpu-strict`

## Что меняет в llama-server

CLI-обработчик записывает целочисленное значение в `params.speculative.draft.cpuparams.strict_cpu`. На этапе `postprocess_cpu_params()` draft CPU-профиль наследует основной `params.cpuparams`, если не был задан отдельно.

В `ggml-cpu` strict placement влияет на `ggml_thread_cpumask_next()`: при `false` worker получает всю global mask, при `true` каждый worker получает отдельный CPU из mask по кругу. Однако текущий `server-context.cpp` при загрузке draft-модели копирует из `params_spec.cpuparams` только `n_threads`, поэтому применение draft-specific `strict_cpu` к draft runtime не подтверждено кодом server load path.

## Значения и формат

Ожидается `0` или `1`. Обработчик принимает `int` и не проверяет диапазон, но help объявляет именно `<0|1>`. Практически используйте только `0` для обычного placement или `1` для strict placement.

## Когда использовать

Используйте `1`, когда вы уже закрепили draft-модель на конкретных CPU через mask/range и хотите уменьшить миграцию worker threads. Не включайте strict placement вслепую: если CPU в mask меньше, чем `--spec-draft-threads`, потоки начнут делить ядра по кругу.

## Влияние на производительность и память

Память не меняется. Strict placement может улучшить cache locality, но может ухудшить балансировку, если draft workload неоднороден или cpuset мал. На машинах с SMT иногда лучше закреплять только physical cores и измерять.

## Взаимодействие с другими аргументами

- `--spec-draft-cpu-mask` и `--spec-draft-cpu-range` задают набор CPU, на который влияет strict placement.
- `--spec-draft-threads` должен соответствовать размеру mask.
- `--cpu-strict` является fallback для draft CPU-профиля, если draft strict не задан.
- `--spec-draft-cpu-strict-batch` относится к batch/prompt draft-профилю.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `cpu-strict-draft = 1`. Router не относит этот параметр к reserved args и передает его дочернему процессу, но фактическое применение draft strict placement нужно проверять для текущего `llama-server`.

## Типовые проблемы и диагностика

- Если значение выглядит как флаг без аргумента, запуск должен упасть на парсинге: это не flag, а boolean value `<0|1>`.
- Если включен strict placement, но CPU не закрепляются, проверьте, применяется ли draft affinity в вашей сборке, и сравните с основным `--cpu-strict`.
- Предупреждение `Not enough set bits in CPU mask ...` означает, что mask уже, чем число потоков.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-cpu-mask 0x0f --spec-draft-cpu-strict 1
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
cpu-mask-draft = 0x0f
cpu-strict-draft = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление и обработчик `--spec-draft-cpu-strict`.
- `llama.cpp/common/common.cpp` - постобработка CPU-профилей.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и текущий перенос только thread counts.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - `ggml_thread_cpumask_next()` и применение affinity.
- `llama.cpp/tools/server/README.md` - help-строка.
