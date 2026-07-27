---
schema: 1
primaryName: "--spec-draft-cpu-strict-batch"
title: "--spec-draft-cpu-strict-batch"
summary: "Переключает strict CPU placement для batch/prompt CPU-профиля draft-модели. Help задает fallback от `--spec-draft-cpu-strict`, но текущий server load path не копирует этот флаг явно в draft runtime."
category: "Параметры speculative decoding"
valueType: "boolean"
valueHint: "<0|1>"
aliases:
  - "--cpu-strict-batch-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-cpu-mask-batch"
  - "--spec-draft-threads-batch"
  - "--spec-draft-cpu-strict"
  - "--cpu-strict-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --spec-draft-cpu-strict-batch

## Кратко

`--spec-draft-cpu-strict-batch` задает strict placement для batch/prompt CPU-профиля draft-модели. Он относится к draft prefill/batch работе, а не к steady-state generation-профилю.

## Оригинальная справка llama.cpp

```text
Use strict CPU placement for draft model (default: --cpu-strict-draft)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-cpu-strict-batch`
- Алиасы: `--cpu-strict-batch-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `boolean`
- Подсказка формата: `<0|1>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `--cpu-strict-draft`

## Что меняет в llama-server

CLI-обработчик записывает значение в `params.speculative.draft.cpuparams_batch.strict_cpu`. После парсинга batch CPU-профиль draft участвует в `postprocess_cpu_params()` с role model `params.cpuparams_batch`.

В ggml CPU backend strict placement управляет распределением worker threads по affinity mask. Однако при загрузке draft-модели `server-context.cpp` копирует в `params_dft` только `n_threads` и `n_threads_batch`, поэтому draft batch strict flag не переносится явно в draft runtime на проверенном commit.

## Значения и формат

Используйте `0` или `1`: `0` дает каждому worker всю mask, `1` распределяет workers по CPU из mask по кругу. Обработчик принимает `int` без собственной проверки диапазона, но help объявляет `<0|1>`.

## Когда использовать

Используйте только вместе с batch affinity draft-профиля и после проверки фактического применения. Если у вас длинные prompts и CPU-bound draft prefill, strict placement может уменьшить миграции, но на узкой mask способен ухудшить throughput.

## Влияние на производительность и память

Память не меняется. Эффект проявляется только при работающей affinity mask. Слишком строгая раскладка на маленьком наборе CPU может ухудшить балансировку batch-фазы.

## Взаимодействие с другими аргументами

- `--spec-draft-cpu-mask-batch` и `--spec-draft-cpu-range-batch` задают mask, к которой применяется strict placement.
- `--spec-draft-threads-batch` должен соответствовать размеру mask.
- `--spec-draft-cpu-strict` является логическим fallback для draft batch strict.
- `--cpu-strict-batch` является fallback batch-профиля target, если draft batch-профиль не задан.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `cpu-strict-batch-draft = 1`. Router не удаляет draft CPU-параметры, но применение этого флага к runtime draft-контекста нужно подтверждать внешней проверкой.

## Типовые проблемы и диагностика

- Если аргумент указан без значения, парсер ожидает `<0|1>` и запуск не должен считаться корректным.
- Если strict batch placement не виден по системным инструментам, причина может быть в том, что `server-context.cpp` не копирует draft batch strict flag.
- Если throughput batch-фазы упал, уменьшите `--spec-draft-threads-batch` или отключите strict placement.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-threads-batch 8 --spec-draft-cpu-mask-batch 0xff --spec-draft-cpu-strict-batch 1
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
threads-batch-draft = 8
cpu-mask-batch-draft = 0xff
cpu-strict-batch-draft = 1
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление и обработчик `--spec-draft-cpu-strict-batch`.
- `llama.cpp/common/common.cpp` - postprocess CPU-профилей.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и ограничение копирования CPU-профиля.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - strict CPU placement.
- `llama.cpp/tools/server/README.md` - help-строка.
