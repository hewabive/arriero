---
schema: 1
primaryName: "--perf"
title: "--perf"
summary: "Управляет внутренними performance timings libllama и sampler. В коде состояние хранится инвертированно как `params.no_perf`: `--perf` сбрасывает его в `false`, `--no-perf` выставляет `true`."
category: "Общие параметры"
valueType: "boolean"
valueHint: null
aliases:
  - "--no-perf"
allowedValues: []
env:
  - "LLAMA_ARG_PERF"
related:
  - "--metrics"
  - "--slots"
  - "--verbosity"
---

# --perf

## Кратко

`--perf` включает, а `--no-perf` отключает внутренние performance timings libllama и sampler. В текущем коде поле называется `no_perf`, поэтому логика обработчика инвертирована: положительный флаг записывает `params.no_perf = false`.

## Оригинальная справка llama.cpp

```text
whether to enable internal libllama performance timings (default: false)
```

## Паспорт аргумента

- Основное имя: `--perf`
- Алиасы: `--perf`, `--no-perf`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `boolean`
- Подсказка формата: `нет значения`
- Допустимые значения: `не ограничены в metadata`
- Переменные окружения: `LLAMA_ARG_PERF`
- Значение по умолчанию: `params.no_perf = false`

## Что меняет в llama-server

Обработчик boolean-аргумента записывает `params.no_perf = !value` и `params.sampling.no_perf = !value`. Далее `common_context_params_to_llama()` переносит значение в `llama_context_params.no_perf`, а sampler использует `params.sampling.no_perf` при измерении времени.

## Значения и формат

Это paired boolean flag: используйте `--perf` или `--no-perf` без отдельного значения. В INI-пресете положительная форма пишется как `perf = true`, отрицательная как `perf = false`, после чего `common_preset::to_args()` выберет `--perf` или `--no-perf`.

## Когда использовать

Оставляйте timings включенными при benchmark, диагностике latency и анализе ответа `/completion`, где важны prompt/predicted timing fields. Используйте `--no-perf`, если нужна минимальная служебная работа и вы не собираете timing metrics из libllama/sampler.

## Влияние на производительность и память

На память модели, KV-cache и VRAM не влияет. Измерения добавляют небольшой overhead на горячем пути; обычно он меньше шума реальной генерации, но для tight benchmark стоит явно фиксировать одно состояние флага во всех запусках.

## Взаимодействие с другими аргументами

- `--metrics` публикует Prometheus-compatible endpoint, но не заменяет libllama internal timings.
- `--slots` и ответы API могут показывать runtime state; наличие точных timing fields зависит от того, не отключены ли perf measurements.
- `--verbosity` влияет на объем логов, а не на сбор timing counters.

## INI-пресеты и router-режим

В локальном `--models-preset` параметр записывается по длинному имени без ведущих дефисов, например `perf = true`. `common_preset::to_args()` рендерит последнюю форму алиаса обратно в CLI-аргументы.

Для router-режима параметр может входить в глобальную секцию `[*]` или в секцию конкретной модели. Router удаляет только зарезервированные сетевые и модельные параметры вроде `LLAMA_ARG_HOST`, `LLAMA_ARG_PORT`, `LLAMA_ARG_MODEL`, `LLAMA_ARG_MODELS_PRESET`; CPU, NUMA, logging и verbosity не входят в этот список и передаются дочернему `llama-server`, если указаны в пресете.

## Типовые проблемы и диагностика

- Если timing fields пропали или стали нулевыми после изменения конфигурации, проверьте, не появился ли `--no-perf` в argv или пресете.
- При сравнении benchmark всегда записывайте состояние `--perf`/`--no-perf`, потому что флаг меняет саму измерительную инфраструктуру.

## Примеры

```bash
llama-server --model /models/model.gguf --perf
```

```bash
llama-server --model /models/model.gguf --no-perf
```

```ini
[*]
perf = true
```

## Источники

- `llama.cpp/common/arg.cpp` - обработчик `--perf`/`--no-perf`.
- `llama.cpp/common/common.h` - поля `params.no_perf` и `params.sampling.no_perf`.
- `llama.cpp/common/common.cpp` - перенос в `llama_context_params.no_perf`.
- `llama.cpp/common/sampling.cpp` - использование `no_perf` в sampler timings.
- `llama.cpp/tools/server/README.md` - описание performance information в ответах сервера.
