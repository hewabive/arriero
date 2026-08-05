---
schema: 1
primaryName: "--repack"
title: "--repack"
summary: "Управляет использованием extra buffer types для weight repacking. По умолчанию repacking включен; `--no-repack` отключает эти extra buffer types."
category: "Общие параметры"
valueType: "boolean"
valueHint: null
aliases:
  - "--repack"
  - "-nr"
  - "--no-repack"
allowedValues: []
env:
  - "LLAMA_ARG_REPACK"
related:
  - "--no-host"
  - "--override-tensor"
---

# --repack

## Кратко

`--repack` разрешает weight repacking через extra buffer types. В текущем llama.cpp это включено по умолчанию, а `--no-repack` выставляет `no_extra_bufts = true` и отключает добавление extra buffer types.

## Оригинальная справка llama.cpp

```text
whether to enable weight repacking (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--repack`
- Алиасы: `--repack`, `-nr`, `--no-repack`
- Переменная окружения: `LLAMA_ARG_REPACK`
- Поле `common_params`: `no_extra_bufts`
- Поле `llama_model_params`: `use_extra_bufts`
- Значение по умолчанию: enabled
- Этап применения: построение buffer type list при загрузке модели

## Что меняет в llama-server

Парсер bool-аргумента инвертирует значение: включенный `--repack` означает `no_extra_bufts = false`, а `--no-repack` - `true`. В `common_model_params_to_llama()` это становится `use_extra_bufts = !params.no_extra_bufts`.

В `make_cpu_buft_list()` и `make_gpu_buft_list()` extra buffer types добавляются только если `use_extra_bufts` включен.

## Значения и формат

CLI использует формы без значения: `--repack` или `--no-repack`. Через env для boolean-аргументов llama.cpp принимает truthy/falsey значения, а также совместимую форму `LLAMA_ARG_NO_REPACK`, если она присутствует.

## Когда использовать

Оставляйте включенным для дефолтной производительности. Используйте `--no-repack`, если подозреваете ошибку backend-specific repacking, хотите сравнить baseline или отладить несовместимость с конкретной моделью/LoRA.

## Влияние на производительность и память

Repacking может ускорить операции с весами ценой другого формата хранения и потенциально другого объема/типа буфера. Отключение часто упрощает поведение, но может снизить throughput.

На CPU-only b10276 stories15M default repack дал 14 MiB model buffer, а `--no-repack` — 17 MiB. На крупных/других quant types разница может быть существенно больше и не выводится из исходного tensor sum. Поэтому Arriero помечает явный `--no-repack` как `low` confidence.

## Взаимодействие с другими аргументами

`--no-host` меняет доступность host buffer в CPU fallback list и может влиять на то, какие extra buffer types реально выбираются.

`--override-tensor` может принудительно выбрать buffer type для отдельных тензоров; при CPU override llama.cpp все равно рассматривает extra CPU buffer types, если repacking включен.

## INI-пресеты и router-режим

В INI:

```ini
repack = true
```

Для отключения:

```ini
no-repack = true
```

В router-режиме задавайте в model preset, если проблема проявляется только на конкретной модели.

## Типовые проблемы и диагностика

- Падение при загрузке на конкретном backend: повторите с `--no-repack`.
- Производительность ниже ожидаемой: убедитесь, что repacking не отключен глобальным preset/env.
- Изменился тип/размер буфера: сравните строки `model buffer size` и debug-логи выбора buffer type.

## Примеры

```bash
llama-server --model /models/model.gguf --repack
```

```bash
llama-server --model /models/model.gguf --no-repack
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-model.cpp`
- `llama.cpp/tools/server/README.md`
