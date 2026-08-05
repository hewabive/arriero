---
schema: 1
primaryName: "--threads"
title: "--threads"
summary: "Задает число CPU-потоков основного inference threadpool для генерации токенов. Значения `0` и ниже сразу заменяются на `std::thread::hardware_concurrency()`, а незаданное `-1` на этапе постобработки превращается в `common_cpu_get_num_math()`."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-t"
allowedValues: []
env:
  - "LLAMA_ARG_THREADS"
related:
  - "--threads-batch"
  - "--cpu-mask"
  - "--cpu-range"
  - "--cpu-strict"
  - "--prio"
  - "--poll"
  - "--numa"
  - "--threads-http"
---

# --threads

## Кратко

Управляет CPU-потоками, которые libllama использует для основной генерации. Это не HTTP worker pool и не количество одновременных слотов.

## Оригинальная справка llama.cpp

```text
number of CPU threads to use during generation (default: -1)
```

## Паспорт аргумента

- Основное имя: `--threads`
- Алиасы: `-t`, `--threads`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_THREADS`
- Значение по умолчанию: `-1`

## Что меняет в llama-server

Обработчик записывает значение в `params.cpuparams.n_threads`. Если пользователь передал `0` или отрицательное значение через сам аргумент, оно сразу заменяется на `std::thread::hardware_concurrency()`. Если аргумент не указан, поле остается `-1` до `postprocess_cpu_params()`, где выбирается `common_cpu_get_num_math()`. Затем итог попадает в `llama_context_params.n_threads` и в параметры ggml threadpool.

## Значения и формат

`N` - целое число. Практически полезны положительные значения от `1` до числа физических или производительных ядер. `0`, `-1` и другие отрицательные значения допустимы парсером, но означают автоматический выбор разными путями: явно переданное значение идет через `hardware_concurrency()`, незаданное значение через `common_cpu_get_num_math()`.

## Когда использовать

Используйте `--threads`, когда модель частично или полностью считает на CPU, когда нужно ограничить нагрузку сервера, либо когда автоматический выбор перегружает машину. Для GPU-heavy конфигураций слишком большое значение часто не ускоряет decode, но может мешать HTTP worker threads и системным задачам.

## Влияние на производительность и память

Память модели, KV-cache и VRAM напрямую не меняются. Latency и throughput меняются сильно: слишком мало потоков недогружает CPU, слишком много ухудшает cache locality и конкурирует с `--threads-http`. При ручной affinity число потоков должно помещаться в маску, иначе будет предупреждение о нехватке set bits.

## Взаимодействие с другими аргументами

- `--threads-batch` по умолчанию наследует итоговые настройки `--threads`, включая число потоков, affinity, priority, strict placement и polling, если batch-параметры не заданы отдельно.
- `--cpu-mask` и `--cpu-range` заполняют одну и ту же маску `params.cpuparams.cpumask`; при указании обоих аргументов биты фактически добавляются к уже выставленным.
- `--cpu-strict` меняет способ распределения потоков по выставленной маске: без него каждый поток получает всю маску, с ним потоки получают отдельные CPU по кругу.
- `--prio` и `--poll` применяются к тому же CPU threadpool, поэтому их стоит настраивать вместе с `--threads` и affinity.
- `--numa` включает отдельную NUMA-логику CPU backend; не смешивайте ее с ручной affinity, пока не измерили результат на конкретной машине.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `threads = 8`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если маска содержит меньше выставленных CPU, чем `--threads`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --threads 8
```

```bash
llama-server --model /models/model.gguf --threads 6 --threads-batch 12
```

```ini
[*]
threads = 8
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
