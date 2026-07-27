---
schema: 1
primaryName: "--override-tensor"
title: "--override-tensor"
summary: "Принудительно задает buffer type для тензоров, имена которых совпадают с regex-паттерном. Это опасный низкоуровневый инструмент для ручного размещения весов."
category: "Общие параметры"
valueType: "list"
valueHint: "<tensor name pattern>=<buffer type>,..."
aliases:
  - "-ot"
  - "--override-tensor"
allowedValues: []
env:
  - "LLAMA_ARG_OVERRIDE_TENSOR"
related:
  - "--device"
  - "--fit"
  - "--gpu-layers"
  - "--cpu-moe"
  - "--n-cpu-moe"
  - "--batch-size"
  - "--mmap"
  - "--repack"
---

# --override-tensor

## Кратко

`--override-tensor` добавляет правила вида `<tensor name pattern>=<buffer type>` и заставляет loader выбирать указанный buffer type для совпавших тензоров. Паттерн интерпретируется как C++ `std::regex` и проверяется через `std::regex_search()`.

Это не обычный tuning-флаг. Ошибочное правило может сломать загрузку модели или резко ухудшить производительность.

## Оригинальная справка llama.cpp

```text
override tensor buffer type
```

## Паспорт аргумента

- Основное имя: `--override-tensor`
- Алиасы: `-ot`, `--override-tensor`
- Переменная окружения: `LLAMA_ARG_OVERRIDE_TENSOR`
- Поле `common_params`: `tensor_buft_overrides`
- Поле `llama_model_params`: `tensor_buft_overrides`, NULL-terminated список
- Формат: `<regex>=<buffer type>,...`
- Этап применения: создание тензоров при загрузке модели

## Что меняет в llama-server

Парсер сначала загружает backends, строит map доступных buffer types по имени `ggml_backend_buft_name()`, затем разбивает строку по запятым. Для каждого элемента требуется `=`.

Если buffer type неизвестен, llama.cpp печатает `Available buffer types:` и завершает обработку аргумента ошибкой `unknown buffer type`. После парсинга список overrides дополняется терминатором `{nullptr, nullptr}`.

При создании tensor loader идет по overrides в порядке добавления и останавливается на первом regex-совпадении (`break`), то есть побеждает первое правило. Если override указывает на CPU buffer, loader заново выбирает подходящий CPU/extra buffer type; при включенном mmap печатает warning с рекомендацией рассмотреть `--no-mmap`.

Порядок правил важен в гибридных конфигурациях: чтобы оставить experts первых слоев на GPU, а остальных на CPU, правило для GPU должно идти раньше общего `exps=CPU`, например `blk\.([0-9]|1[0-9])\.=CUDA0,exps=CPU`. Повторные `-ot` накапливаются так же, как элементы через запятую (arriero склеивает список в один аргумент).

## Значения и формат

Пример формы:

```text
blk\.0\..*=CPU
```

Точные имена buffer types зависят от backend и видны в ошибке `Available buffer types` или debug-логах. Паттерн должен быть валидным regex; запятая используется как разделитель правил, поэтому ее нельзя безопасно использовать внутри паттерна.

Для MoE-offload типична подстрока `exps`: правило `exps=CPU` совпадает через `regex_search` со всеми routed-expert тензорами (`ffn_(up|down|gate|gate_up)_(ch|)exps`) и эквивалентно `--cpu-moe`, который добавляет ровно этот regex (`\.ffn_(up|down|gate|gate_up)_(ch|)exps`). Для частичного offload удобнее `--n-cpu-moe`, чем выписывать `-ot` по слоям вручную.

## Когда использовать

Используйте для точечной диагностики размещения весов: например, оставить отдельные MoE tensors на CPU, обойти баг buffer type для конкретного слоя или проверить гипотезу о VRAM. Для стандартного MoE-offload сначала рассмотрите специализированные параметры вроде `--cpu-moe`/`--n-cpu-moe`, если они доступны в вашей конфигурации.

## Влияние на производительность и память

Override может переместить крупные веса между VRAM, host buffer и CPU memory. Это может спасти старт от OOM, но добавить PCIe/host traffic на каждом eval. CPU override с mmap может быть медленным, о чем loader предупреждает.

Наличие tensor overrides отключает условие pipeline parallelism в `llama_context`: pipeline включается только если `!model.has_tensor_overrides()`.

Веса, отправленные на CPU, все равно считаются на GPU, когда batch не меньше `GGML_OP_OFFLOAD_MIN_BATCH` (по умолчанию `32`): ggml копирует их через PCIe. Поэтому prompt processing с CPU-override чувствителен к `--batch-size`/`--ubatch-size`.

## Взаимодействие с другими аргументами

`--fit` не переписывает уже заданные tensor overrides. Если overrides присутствуют, fit может отказаться с сообщением `model_params::tensor_buft_overrides already set by user`.

`--repack` влияет на extra buffer types, которые могут быть выбраны при CPU override.

`--mmap` важен для производительности CPU overrides; при warning попробуйте `--no-mmap`.

`--device`, `--gpu-layers` и `--split-mode` задают базовое распределение, поверх которого применяются overrides.

## INI-пресеты и router-режим

В INI:

```ini
override-tensor = blk\.0\..*=CPU
```

В router-режиме задавайте только для конкретной модели: tensor names и полезные паттерны зависят от архитектуры и GGUF.

## Типовые проблемы и диагностика

- `invalid value`: в одном из правил нет `=`.
- `unknown buffer type`: проверьте список `Available buffer types` в stderr.
- `std::regex` error или падение на старте: проверьте экранирование паттерна.
- Производительность резко упала: проверьте, не ушли ли hot tensors на CPU/host; смотрите debug-логи `buffer type overridden`.

## Примеры

```bash
llama-server --model /models/model.gguf --override-tensor 'blk\.0\..*=CPU'
```

```bash
llama-server --model /models/model.gguf --override-tensor 'blk\.[0-3]\.ffn_.*=CPU' --no-mmap
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/tools/server/README.md`
