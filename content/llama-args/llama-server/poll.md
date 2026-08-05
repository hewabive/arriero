---
schema: 1
primaryName: "--poll"
title: "--poll"
summary: "Задает уровень busy polling основного CPU threadpool при ожидании работы. `0` отключает polling, значение по умолчанию в `common_cpu_params` равно `50`."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "<0...100>"
aliases:
allowedValues: []
env: []
related:
  - "--threads-batch"
  - "--cpu-mask"
  - "--cpu-range"
  - "--cpu-strict"
  - "--prio"
  - "--numa"
  - "--poll-batch"
---

# --poll

## Кратко

Задает уровень busy polling основного CPU threadpool при ожидании работы. `0` отключает polling, значение по умолчанию в `common_cpu_params` равно `50`.

## Оригинальная справка llama.cpp

```text
use polling level to wait for work (0 - no polling, default: 50)
```

## Паспорт аргумента

- Основное имя: `--poll`
- Алиасы: `--poll`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата: `<0...100>`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `50`

## Что меняет в llama-server

Обработчик записывает значение в `params.cpuparams.poll`. При создании ggml threadpool оно передается в `threadpool->poll`; CPU backend использует его как множитель числа spin rounds перед переходом к ожиданию через condition variable.

## Значения и формат

`0` отключает busy polling. Help описывает диапазон `0...100`. Обработчик использует `std::stoul()` и не делает явной проверки верхней границы, но комментарий CPU backend рассчитан именно на шкалу `0..100`; отрицательные строки не подходят для unsigned conversion.

## Когда использовать

Используйте для тонкой настройки latency на CPU-bound сервере. Низкие значения лучше для shared-хоста и экономии CPU, более высокие могут помочь latency при частых коротких задачах, если серверу выделены ядра.

## Влияние на производительность и память

Повышает активное ожидание и потребление CPU даже между кусками работы. Память не меняет. В сочетании с высоким priority может сделать процесс агрессивным к соседним задачам.

## Взаимодействие с другими аргументами

- `--threads-batch` по умолчанию наследует итоговые настройки `--threads`, включая число потоков, affinity, priority, strict placement и polling, если batch-параметры не заданы отдельно.
- `--cpu-mask` и `--cpu-range` заполняют одну и ту же маску `params.cpuparams.cpumask`; при указании обоих аргументов биты фактически добавляются к уже выставленным.
- `--cpu-strict` меняет способ распределения потоков по выставленной маске: без него каждый поток получает всю маску, с ним потоки получают отдельные CPU по кругу.
- `--prio` и `--poll` применяются к тому же CPU threadpool, поэтому их стоит настраивать вместе с `--threads` и affinity.
- `--numa` включает отдельную NUMA-логику CPU backend; не смешивайте ее с ручной affinity, пока не измерили результат на конкретной машине.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `poll = 0`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если маска содержит меньше выставленных CPU, чем `--threads`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --poll 0
```

```bash
llama-server --model /models/model.gguf --poll 50 --threads 8
```

```ini
[*]
poll = 0
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
