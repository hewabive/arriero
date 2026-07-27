---
schema: 1
primaryName: "--spec-draft-poll-batch"
title: "--spec-draft-poll-batch"
summary: "Задает polling для batch/prompt CPU-профиля draft-модели. Help показывает `<0|1>` и fallback от `--spec-draft-poll`; обработчик сохраняет целое значение в `uint32_t`."
category: "Параметры speculative decoding"
valueType: "boolean"
valueHint: "<0|1>"
aliases:
  - "--poll-batch-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-poll"
  - "--spec-draft-prio-batch"
  - "--spec-draft-threads-batch"
  - "--poll-batch"
  - "--batch-size"
  - "--ubatch-size"
---

# --spec-draft-poll-batch

## Кратко

`--spec-draft-poll-batch` управляет busy polling для batch/prompt CPU-профиля draft-модели. Он относится к draft prefill/batched work, а `--spec-draft-poll` - к generation-профилю draft.

## Оригинальная справка llama.cpp

```text
Use polling to wait for draft model work (default: --poll-draft)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-poll-batch`
- Алиасы: `--poll-batch-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `boolean`
- Подсказка формата: `<0|1>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `--poll-draft`

## Что меняет в llama-server

CLI-обработчик записывает `int value` в `params.speculative.draft.cpuparams_batch.poll`, поле типа `uint32_t`. Диапазон не проверяется, но help объявляет `<0|1>`.

В ggml CPU backend polling управляет активным ожиданием worker threads перед блокировкой. В текущем server load path draft batch polling не копируется явно в `params_dft.cpuparams_batch`, поэтому его runtime-применение для draft-контекста не подтверждено кодом `server-context.cpp`.

## Значения и формат

Для переносимой конфигурации используйте `0` для отключения busy polling или `1` для минимальной help-формы polling. Другие целые значения могут пройти текущий обработчик, но это не документированный контракт draft batch аргумента.

## Когда использовать

Используйте только для latency-sensitive локального сервера с выделенным CPU и после проверки фактического применения. Для shared workload polling batch-профиля draft часто вреден: prefill может начать активно ждать CPU и мешать target/HTTP.

## Влияние на производительность и память

Память не меняется. Polling может снизить latency wakeup для batch-профиля, но повышает CPU utilization и энергопотребление. С `--spec-draft-prio-batch 2` или `3` риск деградации соседних задач выше.

## Взаимодействие с другими аргументами

- `--spec-draft-poll` является логическим fallback для batch draft polling.
- `--spec-draft-prio-batch` усиливает эффект активного ожидания.
- `--spec-draft-threads-batch` определяет, сколько draft batch workers может активно ждать.
- `--poll-batch` задает target batch polling и участвует в общем наследовании CPU-профилей.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `poll-batch-draft = 0` или `poll-batch-draft = 1`. Router не удаляет этот параметр из дочернего argv.

## Типовые проблемы и диагностика

- Если CPU загружен в idle/low-throughput режиме, проверьте все polling параметры: `--poll`, `--poll-batch`, `--spec-draft-poll`, `--spec-draft-poll-batch`.
- Если значение вне `0`/`1` используется в старой конфигурации, лучше привести его к help-форме.
- Если polling draft batch не влияет на поведение, учитывайте ограничение копирования CPU-профиля в `server-context.cpp`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-threads-batch 8 --spec-draft-poll-batch 0
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
threads-batch-draft = 8
poll-batch-draft = 0
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление и обработчик `--spec-draft-poll-batch`.
- `llama.cpp/common/common.h` - поле `common_cpu_params.poll`.
- `llama.cpp/common/common.cpp` - CPU postprocess и threadpool params.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и ограничение копирования CPU-профиля.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - polling loop.
- `llama.cpp/tools/server/README.md` - help-строка.
