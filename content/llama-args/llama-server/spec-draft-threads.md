---
schema: 1
primaryName: "--spec-draft-threads"
title: "--spec-draft-threads"
summary: "Задает число CPU-потоков, с которым draft-контекст speculative decoding выполняет generation. Если не задано, после постобработки наследует итоговое значение `--threads`."
category: "Параметры speculative decoding"
valueType: "number"
valueHint: "N"
aliases:
  - "-td"
  - "--threads-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-model"
  - "--spec-type"
  - "--spec-draft-threads-batch"
  - "--threads"
  - "--threads-batch"
  - "--threads-http"
---

# --spec-draft-threads

## Кратко

`--spec-draft-threads` управляет CPU-потоками draft-модели в speculative decoding. Это отдельная настройка от `--threads`: target-модель продолжает использовать основной CPU-профиль, а draft-контекст получает свое число потоков при загрузке draft-модели.

## Оригинальная справка llama.cpp

```text
number of threads to use during generation (default: same as --threads)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-threads`
- Алиасы: `-td`, `--threads-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --threads`

## Что меняет в llama-server

Обработчик CLI записывает значение в `params.speculative.draft.cpuparams.n_threads`. Если передано `0` или отрицательное число, обработчик сразу заменяет его на `std::thread::hardware_concurrency()`.

После разбора аргументов `postprocess_cpu_params()` дополняет draft CPU-профиль из основного `params.cpuparams`, если draft-профиль остался незаданным. В `tools/server/server-context.cpp` при загрузке draft-модели создается `params_dft = params_base`; если `params.speculative.draft.cpuparams.n_threads > 0`, сервер копирует `n_threads` в `params_dft.cpuparams.n_threads`. Затем `common_context_params_to_llama()` переносит это значение в `llama_context_params.n_threads` draft-контекста.

Аргумент имеет смысл только когда используется draft-контекст: например, задан `--spec-draft-model` или включен draft/MTP speculative type, который реально создает draft-контекст. Ngram-only speculative decoding не использует этот параметр как отдельную draft-модель.

## Значения и формат

`N` - целое число. Положительное значение фиксирует число CPU-потоков draft generation. Явно переданные `0`, `-1` и другие отрицательные значения превращаются в `std::thread::hardware_concurrency()`, а полностью незаданное значение наследует итоговый `--threads` через постобработку.

Практически полезные значения обычно меньше, чем для target-модели: draft-модель должна быть дешевой и не должна отбирать все CPU у проверки токенов target-моделью.

## Когда использовать

Настраивайте `--spec-draft-threads`, если draft-модель считает заметную часть графа на CPU, а speculative decoding не ускоряет сервер из-за конкуренции потоков. На CPU-only сервере часто выгодно дать draft-модели несколько ядер, а target оставить основной пул. На GPU-heavy draft-модели параметр может почти не влиять.

## Влияние на производительность и память

Память модели, VRAM и KV-cache напрямую не меняются. Меняется CPU latency draft-step и конкуренция с target generation, prompt processing и HTTP worker threads. Слишком большое значение может снизить acceptance benefit speculative decoding: draft быстро генерирует кандидаты, но target и серверные потоки начинают ждать CPU.

## Взаимодействие с другими аргументами

- `--spec-draft-threads-batch` задает batch/prompt CPU-потоки draft-контекста; если он не задан, через постобработку наследуется draft generation-профиль.
- `--threads` является fallback для draft CPU-профиля, когда `--spec-draft-threads` не задан.
- `--threads-batch` является fallback для `--spec-draft-threads-batch`, если batch-профиль draft не задан.
- `--spec-draft-cpu-mask`, `--spec-draft-cpu-strict`, `--spec-draft-prio` и `--spec-draft-poll` парсятся в draft CPU-профиль, но в текущем `server-context.cpp` при загрузке draft-модели явно копируются только thread counts. Для affinity/priority/polling проверяйте фактическое поведение на вашей сборке.
- Старые `--draft`, `--draft-n`, `--draft-max` удалены и не заменяют этот параметр; для числа draft-токенов используйте `--spec-draft-n-max`.

## INI-пресеты и router-режим

В `--models-preset` аргумент можно задавать как CLI-ключ без ведущих дефисов. `common_preset::to_args()` рендерит последнюю форму алиаса, поэтому канонический ключ для пресета - `threads-draft = 4`.

Router удаляет сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_ALIAS`, `LLAMA_ARG_HF_REPO`; draft CPU-параметры не входят в список reserved args и могут передаваться дочернему `llama-server`.

## Типовые проблемы и диагностика

- Если speculative decoding не активен, параметр будет разобран, но отдельного draft-контекста не появится. Ищите в логах `loading draft model`, `creating MTP draft context` и `speculative decoding context initialized`.
- Если `N` слишком велик, возможен рост latency из-за конкуренции с `--threads`, `--threads-batch` и `--threads-http`.
- Если `--spec-draft-threads-batch` не задан, batch-профиль draft наследует draft generation-профиль после постобработки.
- Для общей проверки CPU-профиля смотрите `system_info: n_threads = ...`; draft-specific thread count отдельно в server log не печатается в проверенном коде.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4
```

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --threads 12 --spec-draft-threads 3 --threads-http 4
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--spec-draft-threads`, обработчик CLI и постобработка CPU-профилей.
- `llama.cpp/common/common.h` - `common_cpu_params` и поля `common_params_speculative`.
- `llama.cpp/common/common.cpp` - `postprocess_cpu_params()` и перенос thread counts в `llama_context_params`.
- `llama.cpp/common/speculative.cpp` - инициализация speculative implementations.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и копирование draft thread counts.
- `llama.cpp/tools/server/README.md` - актуальная строка help и пример `model-draft` в presets.
