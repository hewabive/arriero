---
schema: 1
primaryName: "--spec-draft-poll"
title: "--spec-draft-poll"
summary: "Задает polling level для ожидания работы draft-модели в generation CPU-профиле. Help показывает `<0|1>`, но обработчик сохраняет целое значение в `uint32_t`, как и основной CPU-параметр polling."
category: "Параметры speculative decoding"
valueType: "boolean"
valueHint: "<0|1>"
aliases:
  - "--poll-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-threads"
  - "--spec-draft-prio"
  - "--poll"
  - "--prio"
---

# --spec-draft-poll

## Кратко

`--spec-draft-poll` управляет busy polling для CPU worker-профиля draft-модели. Значение `0` отключает активное ожидание; положительное значение увеличивает время, которое worker threads тратят на spin-wait перед обычным ожиданием.

## Оригинальная справка llama.cpp

```text
Use polling to wait for draft model work (default: same as --poll)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-poll`
- Алиасы: `--poll-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `boolean`
- Подсказка формата: `<0|1>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --poll`

## Что меняет в llama-server

CLI-обработчик записывает `int value` в `params.speculative.draft.cpuparams.poll`, поле типа `uint32_t`. Диапазон в обработчике не проверяется, хотя help для draft-варианта показывает `<0|1>`.

В ggml CPU backend polling участвует в цикле ожидания worker threads: чем больше уровень, тем больше spin rounds перед блокирующим ожиданием. Но, как и для draft affinity/priority, `server-context.cpp` при загрузке draft-модели явно копирует из draft CPU-профиля только thread counts, поэтому применение draft-specific polling к runtime draft-контекста не подтверждено текущим кодом server load path.

## Значения и формат

Используйте `0` или `1`, если хотите соответствовать help. Технически обработчик принимает любое целое, которое помещается при присваивании в `uint32_t`, но это не описанный контракт для draft-аргумента. Основной `--poll` документирован шире как уровень `0...100`; draft help ограничивает форму `<0|1>`.

## Когда использовать

Включайте polling только для latency-sensitive локального сервера, где CPU выделен под inference и важнее минимальная задержка пробуждения worker threads. Для публичного сервера, shared VM и ноутбука обычно лучше `0` или наследование умеренного `--poll`.

## Влияние на производительность и память

Память не меняется. Polling может немного уменьшить latency ожидания работы, но повышает активную загрузку CPU и энергопотребление. В сочетании с `--spec-draft-prio 2` или `3` может мешать target-модели и HTTP worker threads.

## Взаимодействие с другими аргументами

- `--poll` является fallback для draft polling, если draft CPU-профиль не задан.
- `--spec-draft-prio` усиливает эффект polling на соседние задачи.
- `--spec-draft-threads` определяет число draft workers, которые могут активно ждать работу.
- `--spec-draft-poll-batch` относится к batch/prompt CPU-профилю draft и по help наследует `--poll-draft`.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ `poll-draft = 0` или `poll-draft = 1`. Router не удаляет этот параметр из дочернего argv.

## Типовые проблемы и диагностика

- Если CPU загружен даже при малом throughput, проверьте `--poll`, `--poll-batch`, `--spec-draft-poll` и batch draft polling.
- Если значение вне `0`/`1` работает, это следствие текущего обработчика, а не обещание help; для переносимой конфигурации используйте `0` или `1`.
- Если draft polling не меняет поведение, проверьте ограничение `server-context.cpp`: draft-specific polling может не переноситься в draft runtime.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-poll 0
```

```ini
[*]
model-draft = /models/draft.gguf
poll-draft = 0
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление и обработчик `--spec-draft-poll`.
- `llama.cpp/common/common.h` - поле `common_cpu_params.poll`.
- `llama.cpp/common/common.cpp` - постобработка и перенос polling в threadpool params.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и ограничение копирования draft CPU-профиля.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - polling loop в CPU backend.
- `llama.cpp/tools/server/README.md` - help-строка.
