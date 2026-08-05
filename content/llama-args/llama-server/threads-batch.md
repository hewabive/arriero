---
schema: 1
primaryName: "--threads-batch"
title: "--threads-batch"
summary: "Задает число CPU-потоков для prompt/batch processing. Если параметр не указан, batch CPU-профиль наследуется от `--threads` после постобработки."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-tb"
allowedValues: []
env: []
related:
  - "--threads"
  - "--cpu-mask-batch"
  - "--cpu-range-batch"
  - "--cpu-strict-batch"
  - "--prio-batch"
  - "--poll-batch"
  - "--batch-size"
  - "--ubatch-size"
  - "--flash-attn"
---

# --threads-batch

## Кратко

Отдельно настраивает CPU-потоки для обработки prompt/batch, то есть фазы, где сервер прогоняет пачки токенов перед обычным token-by-token decode.

## Оригинальная справка llama.cpp

```text
number of threads to use during batch and prompt processing (default: same as --threads)
```

## Паспорт аргумента

- Основное имя: `--threads-batch`
- Алиасы: `-tb`, `--threads-batch`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --threads`

## Что меняет в llama-server

Обработчик записывает значение в `params.cpuparams_batch.n_threads`. Явное `0` или отрицательное значение заменяется на `std::thread::hardware_concurrency()`. Если аргумент не указан, `postprocess_cpu_params(params.cpuparams_batch, &params.cpuparams)` копирует весь основной CPU-профиль, а `common.cpp` передает итог в `llama_context_params.n_threads_batch`.

## Значения и формат

`N` - целое число. Положительное значение фиксирует размер batch threadpool. Отсутствие аргумента означает наследование `--threads`; явно переданное `0` или `-1` не наследует `--threads`, а выбирает `hardware_concurrency()`.

## Когда использовать

Используйте при длинных prompt, больших `--batch-size`/`--ubatch-size`, embedding/rerank нагрузках или когда prompt ingestion должен быть быстрее обычной генерации. Частый профиль для локального сервера: умеренный `--threads` для decode и больше `--threads-batch` для загрузки длинного контекста.

## Влияние на производительность и память

Влияет на скорость prompt processing и prefill, но не меняет размер KV-cache. Слишком высокое значение может ухудшить интерактивную latency, потому что batch-фаза начнет забирать CPU у HTTP threads и у основного decode.

## Взаимодействие с другими аргументами

- `--threads` является моделью наследования для batch CPU-профиля, если `--threads-batch` не задан.
- `--cpu-mask-batch`, `--cpu-range-batch`, `--cpu-strict-batch`, `--prio-batch` и `--poll-batch` настраивают тот же batch CPU-профиль.
- `--batch-size` и `--ubatch-size` определяют объем работы, который batch-потоки будут обрабатывать за вызов decode.
- `--flash-attn` и GPU offload могут сместить bottleneck с CPU на backend устройства, поэтому оптимальное значение надо измерять отдельно.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `threads-batch = 12`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если маска содержит меньше выставленных CPU, чем `--threads`, при постобработке появляется предупреждение `Not enough set bits in CPU mask ...`; в такой конфигурации часть потоков будет конкурировать за те же ядра.
- Ошибки `invalid cpumask`, `invalid range`, `Start index out of bounds` или `End index out of bounds` означают, что аргумент не прошел парсер `parse_cpu_mask()`/`parse_cpu_range()`.
- Предупреждения `failed to set affinity` или `failed to set thread priority` печатает CPU backend, когда ОС не разрешила affinity/scheduler policy или CPU index отсутствует в доступном cpuset.
- Для проверки фактических значений смотрите строку `system_info: n_threads = ...`; для HTTP-пула отдельно печатается `using N threads for HTTP server`.

## Примеры

```bash
llama-server --model /models/model.gguf --threads 6 --threads-batch 12
```

```bash
llama-server --model /models/model.gguf --batch-size 4096 --ubatch-size 512 --threads-batch 16
```

```ini
[*]
threads = 6
threads-batch = 12
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление аргумента, help-текст, обработчик CLI и env.
- `llama.cpp/common/common.h` - поля `common_params` и `common_cpu_params`.
- `llama.cpp/common/common.cpp` - постобработка CPU-параметров, парсинг CPU mask/range, перенос в `llama_context_params` и `ggml_threadpool_params`.
- `llama.cpp/tools/server/server.cpp` и `tools/server/server-context.cpp` - применение параметров при старте `llama-server` и загрузке модели.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity, strict CPU placement, thread priority и polling в CPU backend.
