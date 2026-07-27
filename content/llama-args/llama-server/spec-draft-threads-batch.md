---
schema: 1
primaryName: "--spec-draft-threads-batch"
title: "--spec-draft-threads-batch"
summary: "Задает CPU-потоки draft-контекста для batch и prompt processing. Если не задано, наследует `--spec-draft-threads`, а при отсутствии draft-профиля - итоговый batch-профиль target."
category: "Параметры speculative decoding"
valueType: "number"
valueHint: "N"
aliases:
  - "-tbd"
  - "--threads-batch-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-model"
  - "--spec-draft-threads"
  - "--threads"
  - "--threads-batch"
  - "--batch-size"
  - "--ubatch-size"
  - "--flash-attn"
---

# --spec-draft-threads-batch

## Кратко

`--spec-draft-threads-batch` задает число CPU-потоков draft-контекста для batch/prompt-фазы. В отличие от `--spec-draft-threads`, этот параметр используется для batched decode в libllama, включая обработку prompt и крупных batch-кусков draft-контекста.

## Оригинальная справка llama.cpp

```text
number of threads to use during batch and prompt processing (default: same as --threads-draft)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-threads-batch`
- Алиасы: `-tbd`, `--threads-batch-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `number`
- Подсказка формата: `N`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --threads-draft`

## Что меняет в llama-server

CLI-обработчик записывает значение в `params.speculative.draft.cpuparams_batch.n_threads`. Если пользователь передал `0` или отрицательное значение, оно сразу заменяется на `std::thread::hardware_concurrency()`.

После парсинга `postprocess_cpu_params(params.speculative.draft.cpuparams_batch, &params.cpuparams_batch)` дополняет batch-профиль draft из batch-профиля target, если draft batch-профиль не задан. При загрузке draft-модели `server-context.cpp` копирует `params_spec.cpuparams_batch.n_threads` в `params_dft.cpuparams_batch.n_threads`, но только если `params_spec.cpuparams.n_threads > 0`. После этого `common_context_params_to_llama()` переносит значение в `llama_context_params.n_threads_batch` draft-контекста.

## Значения и формат

`N` - целое число. Положительное значение фиксирует число потоков для batch/prompt работы draft-контекста. Явное `0` или отрицательное значение означает `std::thread::hardware_concurrency()`. Если аргумент не указан, значение наследуется из draft generation-профиля или batch-профиля target через общую постобработку.

## Когда использовать

Используйте, когда draft-модель долго обрабатывает prompt, большие speculative batches или multimodal preprocessing на draft-контексте. Если workload состоит из короткого decode и draft-модель в основном на GPU, отдельная настройка batch threads может не дать эффекта.

## Влияние на производительность и память

Параметр не меняет размер KV-cache, batch size или VRAM напрямую. Он может ускорить CPU prefill draft-контекста, но слишком большое значение конкурирует с target `--threads-batch`, HTTP worker threads и другими слотами. При длинных prompts измеряйте отдельно prefill latency и steady-state decode.

## Взаимодействие с другими аргументами

- `--spec-draft-threads` задает generation-профиль draft и является логическим fallback для batch-профиля draft.
- `--threads-batch` задает batch-профиль target и участвует в наследовании, если draft batch-профиль не задан.
- `--batch-size` и `--ubatch-size` определяют объем работы, который может распараллеливаться; `--spec-draft-threads-batch` только задает CPU-потоки для draft-контекста.
- `--flash-attn` и offload draft-модели через `--spec-draft-ngl`/`--spec-draft-device` могут сместить bottleneck с CPU на GPU.
- `--draft`, `--draft-min` и их legacy-алиасы удалены; они не управляют потоками draft-контекста.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ без ведущих дефисов. Так как `common_preset::to_args()` рендерит последнюю форму алиаса, практичная форма для пресета - `threads-batch-draft = 8`.

Router не удаляет draft CPU-параметры при запуске дочерней модели. Он перезаписывает host/port/alias и часть модельных аргументов, но не `threads-batch-draft`.

## Типовые проблемы и диагностика

- Если `--spec-draft-threads` не задан, но `--spec-draft-threads-batch` задан, текущий `server-context.cpp` копирует draft thread counts только при `params_spec.cpuparams.n_threads > 0`. Поэтому для надежной настройки batch-потоков draft задавайте оба параметра.
- Если prompt processing ускорился, но decode latency выросла, уменьшите batch-потоки draft или target `--threads-batch`.
- Draft-specific batch thread count отдельно не печатается в server log; наличие draft-контекста проверяйте по `loading draft model` и `speculative decoding context initialized`.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-threads-batch 8
```

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --threads-batch 16 --spec-draft-threads 3 --spec-draft-threads-batch 6
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
threads-batch-draft = 8
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--spec-draft-threads-batch`, обработчик CLI и постобработка CPU-профилей.
- `llama.cpp/common/common.cpp` - `postprocess_cpu_params()` и `common_context_params_to_llama()`.
- `llama.cpp/tools/server/server-context.cpp` - копирование draft `n_threads` и `n_threads_batch` при загрузке draft-модели.
- `llama.cpp/common/speculative.cpp` - инициализация speculative decoding.
- `llama.cpp/tools/server/README.md` - актуальная help-строка.
