---
schema: 1
primaryName: "--override-kv"
title: "--override-kv"
summary: "Переопределяет отдельные GGUF metadata keys до загрузки модели. Формат строгий: `KEY=TYPE:VALUE`, типы только `int`, `float`, `bool`, `str`; ошибка формата останавливает запуск."
category: "Общие параметры"
valueType: "list"
valueHint: "KEY=TYPE:VALUE,..."
aliases:
  - "--override-kv"
allowedValues: []
env: []
related:
  - "--check-tensors"
  - "--ctx-size"
  - "--rope-scaling"
  - "--rope-freq-base"
  - "--rope-freq-scale"
---

# --override-kv

## Кратко

`--override-kv` - аварийный и диагностический механизм для подмены metadata модели при загрузке GGUF. Он не меняет файл модели на диске, а передает массив `llama_model_kv_override` в `llama_model_params`.

Используйте его только когда точно известен ключ metadata и ожидаемый тип. Неверный override может сломать токенизацию, RoPE-параметры, chat template metadata или другие свойства модели без понятной ошибки на уровне HTTP.

## Оригинальная справка llama.cpp

```text
advanced option to override model metadata by key. to specify multiple overrides, either use comma-separated values. types: int, float, bool, str. example: --override-kv tokenizer.ggml.add_bos_token=bool:false,tokenizer.ggml.add_eos_token=bool:false
```

## Паспорт аргумента

- Основное имя: `--override-kv`
- Алиасы: `--override-kv`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `list`
- Формат: `KEY=TYPE:VALUE`, несколько элементов через запятую
- Переменные окружения: нет
- Поле в `common_params`: `kv_overrides`
- Этап применения: парсинг CLI, postprocess с terminator entry, загрузка модели

## Что меняет в llama-server

В `common/arg.cpp` значение разбирается через `parse_csv_row`, а каждый элемент передается в `string_parse_kv_override`. При успешном разборе entry добавляется в `params.kv_overrides`. В postprocess llama.cpp добавляет завершающий элемент с пустым key, потому что C API ожидает null-like terminator.

В `common/common.cpp` массив передается в `llama_model_params::kv_overrides`. В `src/llama-model-loader.cpp` loader строит map overrides и применяет их при чтении typed metadata. Если тип override не совпадает с ожидаемым типом конкретного ключа, loader логирует warning `Bad metadata override type`.

## Значения и формат

- `int`: целое через `std::atol`, пример `llama.context_length=int:8192`.
- `float`: число через `std::atof`, пример `llama.rope.freq_base=float:10000`.
- `bool`: строго `true` или `false`.
- `str`: строка длиной не больше 127 символов.
- Key до `=` должен быть короче 128 символов.

Запятая разделяет элементы списка. Если значение строки должно содержать запятую, этот CLI-формат для него не подходит без поддержки CSV escaping в конкретном пути генерации argv.

## Когда использовать

- Исправить известный metadata-дефект в GGUF без пересборки файла.
- Проверить гипотезу о metadata перед конвертацией или выпуском новой модели.
- Временно отключить/включить tokenizer flags, например `tokenizer.ggml.add_bos_token`.

## Влияние на производительность и память

Сам override не стоит памяти. Но он может изменить параметры, которые влияют на память и граф: context length, RoPE metadata, tokenizer behavior, architecture-specific flags. Поэтому после изменения сравнивайте логи загрузки модели и контекста, а не только успешный старт HTTP server.

## Взаимодействие с другими аргументами

- Для RoPE часто проще и прозрачнее использовать прямые `--rope-*` аргументы, чем менять metadata через `--override-kv`.
- `--ctx-size` переопределяет runtime context независимо от metadata context length.
- `--check-tensors` проверяет данные tensors, но не доказывает корректность metadata override.
- При нескольких `--override-kv` entries для одного ключа не задавайте один key дважды. В проверенном loader используется `insert` в map, поэтому повторный ключ не должен рассматриваться как надежное переопределение первого.

## INI-пресеты и router-режим

В локальном `--models-preset`:

```ini
[my-model]
override-kv = tokenizer.ggml.add_bos_token=bool:false,tokenizer.ggml.add_eos_token=bool:false
```

В router mode это per-model параметр: он применяется дочерним процессом при загрузке конкретной модели. Не используйте его как глобальный router CLI override, если разные модели требуют разных metadata.

## Типовые проблемы и диагностика

- `Invalid type for KV override`: проверьте префикс типа (`int:`, `float:`, `bool:`, `str:`).
- `invalid boolean value`: для bool допустимы только `true` и `false`.
- Warning `Bad metadata override type`: ключ найден, но тип не совпал с тем, который loader ожидает.
- Override не виден в metadata dump: в loader есть примечание, что KV overrides не применяются к выводу dump metadata; проверяйте фактические логи использования ключа.

## Примеры

```bash
llama-server --model /models/model.gguf --override-kv tokenizer.ggml.add_bos_token=bool:false,tokenizer.ggml.add_eos_token=bool:false
```

```bash
llama-server --model /models/model.gguf --override-kv llama.context_length=int:8192
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/tools/server/README.md`
