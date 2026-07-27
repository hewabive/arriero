---
schema: 1
primaryName: "--lora-scaled"
title: "--lora-scaled"
summary: "Загружает LoRA adapter с явным scale в формате `FNAME:SCALE`. CSV-список позволяет добавить несколько adapters за один аргумент."
category: "Общие параметры"
valueType: "list"
valueHint: "FNAME:SCALE,..."
aliases:
  - "--lora-scaled"
allowedValues: []
env: []
related:
  - "--lora"
  - "--lora-init-without-apply"
  - "--model"
---

# --lora-scaled

## Кратко

`--lora-scaled` добавляет LoRA adapter с пользовательским scale. Каждый CSV-элемент должен иметь формат `FNAME:SCALE`; обработчик записывает `{ path = FNAME, scale = stof(SCALE) }` в `common_params.lora_adapters`.

## Оригинальная справка llama.cpp

```text
path to LoRA adapter with user defined scaling (format: FNAME:SCALE,...)
note: use comma-separated values
```

## Паспорт аргумента

- Основное имя: `--lora-scaled`
- Алиасы: `--lora-scaled`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `list`
- Подсказка формата из `--help`: `FNAME:SCALE,...`
- Переменные окружения: не указаны
- Значение по умолчанию: adapters не загружаются
- Внутреннее поле: `common_params.lora_adapters`

## Что меняет в llama-server

На парсинге каждый элемент делится по `:`. Если частей не ровно две, выбрасывается `lora-scaled format: FNAME:SCALE`. Scale преобразуется через `std::stof`.

Дальше adapter загружается и управляется так же, как `--lora`: через startup apply, `/lora-adapters` и per-request `lora`.

## Значения и формат

Пример:

```text
--lora-scaled /srv/loras/domain.gguf:0.6
```

Несколько:

```text
--lora-scaled /srv/loras/a.gguf:0.5,/srv/loras/b.gguf:1.2
```

Так как разделитель scale - двоеточие, пути с двоеточием проблемны. На Windows это особенно важно для путей вида `C:\...`; для таких случаев безопаснее проверить фактический parser behavior или использовать пути без drive-colon в среде запуска.

## Когда использовать

Используйте `--lora-scaled`, когда adapter должен стартовать не с scale `1.0`: например, частичное смешивание доменного adapter или предзагрузка adapter с `0.0` для последующего включения API.

Для простого scale `1.0` используйте `--lora`.

## Влияние на производительность и память

Память adapter загружается независимо от scale. Scale `0.0` отключает влияние adapter на результат, но сам adapter остается загруженным и доступным для runtime API.

Разные scale в запросах могут мешать batching так же, как разные наборы LoRA.

## Взаимодействие с другими аргументами

- `--lora`: можно смешивать; порядок добавления определяет id adapters в `/lora-adapters`.
- `--lora-init-without-apply`: может обнулить стартовое применение adapters, несмотря на заданный scale.
- Request field `lora`: per-request scale может переопределить startup/global scale.

## INI-пресеты и router-режим

```ini
[scaled_lora]
model = /srv/models/base.gguf
lora-scaled = /srv/loras/domain.gguf:0.6
```

В router-режиме учитывайте, что id adapter зависит от порядка, в котором adapters добавлены при запуске дочернего процесса.

## Типовые проблемы и диагностика

- `lora-scaled format: FNAME:SCALE`: нет двоеточия или их больше одного после CSV-разбора.
- `std::stof` ошибка: scale не является числом.
- Adapter имеет неожиданный id: проверьте порядок всех `--lora` и `--lora-scaled`.

## Примеры

```bash
llama-server --model /srv/models/base.gguf --lora-scaled /srv/loras/domain.gguf:0.7
```

```bash
llama-server --model /srv/models/base.gguf --lora-scaled /srv/loras/a.gguf:0.5,/srv/loras/b.gguf:1.1
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/README.md`
