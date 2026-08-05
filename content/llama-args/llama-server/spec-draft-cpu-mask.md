---
schema: 1
primaryName: "--spec-draft-cpu-mask"
title: "--spec-draft-cpu-mask"
summary: "Парсит hex-маску CPU affinity для generation-профиля draft-модели и наследует `--cpu-mask`, если draft-профиль не задан. В текущем server load path явно применяется только draft thread count, поэтому affinity draft-модели требует проверки на сборке."
category: "Параметры speculative decoding"
valueType: "string"
estimation: "normal"
valueHint: "M"
aliases:
  - "-Cd"
  - "--cpu-mask-draft"
allowedValues: []
env: []
related:
  - "--spec-draft-cpu-range"
  - "--spec-draft-cpu-strict"
  - "--spec-draft-threads"
  - "--cpu-mask"
  - "--cpu-range"
  - "--numa"
---

# --spec-draft-cpu-mask

## Кратко

`--spec-draft-cpu-mask` задает CPU affinity mask для generation CPU-профиля draft-модели. Маска хранится отдельно от target `--cpu-mask` и дополняется `--spec-draft-cpu-range`.

Важная деталь текущего `llama-server`: `common/arg.cpp` корректно парсит и постобрабатывает draft CPU affinity, но `tools/server/server-context.cpp` при загрузке draft-модели явно копирует из draft CPU-профиля только число потоков. Поэтому этот документ описывает подтвержденный parsing/storage contract и отдельно отмечает ограничение применения в server load path.

## Оригинальная справка llama.cpp

```text
Draft model CPU affinity mask. Complements cpu-range-draft (default: same as --cpu-mask)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-cpu-mask`
- Алиасы: `-Cd`, `--cpu-mask-draft`
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения в arriero: `string`
- Подсказка формата: `M`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `не заданы`
- Значение по умолчанию: `same as --cpu-mask`

## Что меняет в llama-server

Обработчик выставляет `params.speculative.draft.cpuparams.mask_valid = true` и вызывает `parse_cpu_mask()` для `params.speculative.draft.cpuparams.cpumask`. После парсинга `postprocess_cpu_params(params.speculative.draft.cpuparams, &params.cpuparams)` наследует основной CPU-профиль, если draft-профиль не был задан.

В общем helper `ggml_threadpool_params_from_cpu_params()` эта маска могла бы попасть в `ggml_threadpool_params.cpumask`, но проверенный `server-context.cpp` для draft-модели создает `params_dft = params_base` и копирует из `params_spec.cpuparams` только `n_threads`. Это означает, что для `llama-server` на commit `751ebd17...` нельзя уверенно считать `--spec-draft-cpu-mask` полноценной runtime-affinity настройкой без локальной проверки логов/поведения.

## Значения и формат

Формат - hex-строка, например `0x0f`, `f0`, `000000ff`. Префикс `0x` разрешен. Парсер принимает `0-9`, `a-f`, `A-F`; максимум обрабатываются 128 hex-цифр, то есть 512 CPU-битов. Младший бит последней hex-цифры соответствует CPU `0`: `0x3` выбирает CPU `0` и `1`, `0xf0` выбирает CPU `4-7`.

`--spec-draft-cpu-mask` и `--spec-draft-cpu-range` заполняют одну bool-маску; если указать оба, биты добавляются.

## Когда использовать

Используйте для изоляции CPU draft-модели от target-модели, когда speculative decoding CPU-bound и вы проверили, что ваша сборка реально применяет draft affinity. Для надежной изоляции на текущем сервере практичнее закреплять весь процесс через ОС, cpuset/cgroup, container CPU pinning или основные `--cpu-mask`/`--cpu-range`.

## Влияние на производительность и память

Affinity не меняет RAM, VRAM и KV-cache. При работающем применении affinity может уменьшить миграции потоков и конкуренцию за cache, но слишком узкая маска ухудшит throughput. Если число draft-потоков больше количества выставленных CPU, `postprocess_cpu_params()` печатает предупреждение `Not enough set bits in CPU mask ...`.

## Взаимодействие с другими аргументами

- `--spec-draft-cpu-range` дополняет ту же маску draft generation-профиля.
- `--spec-draft-cpu-strict` меняет смысл маски: строгая раскладка выдает потокам CPU по кругу, обычная - всю маску каждому worker.
- `--spec-draft-threads` должен соответствовать числу CPU в маске.
- `--cpu-mask` является fallback-профилем, если draft CPU-профиль не задан.
- `--spec-draft-cpu-mask-batch` относится к batch/prompt-профилю draft, а не generation-профилю.

## INI-пресеты и router-режим

В `--models-preset` практичная форма ключа - `cpu-mask-draft = 0x0f`, потому что `common_preset::to_args()` рендерит последнюю форму алиаса. Router не удаляет draft CPU affinity параметры из пресета, но фактическое применение зависит от server load path.

## Типовые проблемы и диагностика

- `invalid cpumask` или `Invalid hex character ...` означает, что строка содержит не-hex символ.
- `Not enough set bits in CPU mask ...` означает, что выставленных CPU меньше, чем `--spec-draft-threads`.
- Если affinity не видна в `taskset`, `ps -o psr` или `htop`, учитывайте ограничение текущего `server-context.cpp`: draft mask может быть разобрана, но не перенесена в draft runtime.
- Ошибки `failed to set affinity` печатает CPU backend, если ОС отклонила маску или CPU недоступен в cpuset/cgroup.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-threads 4 --spec-draft-cpu-mask 0x0f
```

```ini
[*]
model-draft = /models/draft.gguf
threads-draft = 4
cpu-mask-draft = 0x0f
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление, aliases и обработчик `--spec-draft-cpu-mask`.
- `llama.cpp/common/common.cpp` - `parse_cpu_mask()`, `postprocess_cpu_params()` и `ggml_threadpool_params_from_cpu_params()`.
- `llama.cpp/common/common.h` - `common_cpu_params`.
- `llama.cpp/tools/server/server-context.cpp` - загрузка draft-модели и копирование только thread counts.
- `llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c` - применение affinity в ggml threadpool.
- `llama.cpp/tools/server/README.md` - актуальная help-строка.
