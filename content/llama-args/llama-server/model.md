---
schema: 1
primaryName: "--model"
title: "--model"
summary: "Задает локальный путь к основному GGUF-файлу модели. Это базовый источник весов, если модель не выбирается через `--hf-repo`, `--model-url` или `--docker-repo`."
category: "Общие параметры"
valueType: "path"
valueHint: "FNAME"
presetSupport: "model-managed"
aliases:
  - "-m"
  - "--model"
allowedValues: []
env:
  - "LLAMA_ARG_MODEL"
related:
  - "--model-url"
  - "--hf-repo"
  - "--hf-file"
  - "--docker-repo"
  - "--mmproj"
  - "--lora"
  - "--control-vector"
  - "--models-dir"
  - "--models-preset"
---

# --model

## Кратко

`--model` указывает локальный GGUF-файл, который загружает экземпляр `llama-server`. Значение записывается в `common_params.model.path` и применяется до создания `llama_model` и контекстов сервера.

Если одновременно указан `--hf-repo` и `--model`, код трактует `--model` не как локальный файл, а как `--hf-file`: путь переносится в `common_params.model.hf_file`, а локальный `model.path` очищается перед скачиванием из Hugging Face. Для управляемых инстансов это важное исключение.

## Оригинальная справка llama.cpp

```text
model path to load
```

## Паспорт аргумента

- Основное имя: `--model`
- Алиасы: `-m`, `--model`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `path`
- Подсказка формата из `--help`: `FNAME`
- Переменные окружения: `LLAMA_ARG_MODEL`
- Значение по умолчанию: пусто; для обычного запуска модель должна быть задана локально или через удаленный источник
- Внутреннее поле: `common_params.model.path`

## Что меняет в llama-server

На этапе парсинга CLI обработчик записывает строку в `params.model.path`. Позже `common_params_handle_models()` вызывает `common_params_handle_model()`:

- если задан `--docker-repo`, локальный путь заменяется результатом Docker-загрузки;
- если задан `--hf-repo`, непустой `--model` используется как имя файла в репозитории Hugging Face;
- если задан `--model-url`, пустой `--model` автоматически заменяется путем в кэше, рассчитанным из последнего сегмента URL;
- если удаленные источники не заданы, `--model` остается локальным путем и передается в `llama_model_load_from_file()`.

В сервере путь логируется при старте строкой вида `loading model '<path>'`. После успешной загрузки он определяет tokenizer, chat template, архитектуру, доступный контекст, поддержку embedding/reranking и совместимость LoRA/control vectors.

## Значения и формат

Ожидается путь к файлу GGUF. Относительные пути разрешаются относительно текущего рабочего каталога процесса `llama-server`, поэтому в arriero надежнее хранить абсолютные пути.

Для split GGUF при локальном `--model` обычно указывают первый shard, например `model-00001-of-00003.gguf`; соседние части должны лежать рядом и иметь согласованные имена. Сам `--model` не скачивает недостающие локальные части.

Путь не является URL. Для URL используйте `--model-url`, для Hugging Face - `--hf-repo` и `--hf-file`, для Docker Hub - `--docker-repo`.

## Когда использовать

Используйте `--model`, когда GGUF уже лежит на диске и вы хотите полностью контролировать путь, права доступа и обновление файла. Это лучший вариант для offline-развертываний, предзагруженных моделей и production-инстансов, где нежелательны сетевые обращения на старте.

Не смешивайте `--model` с `--hf-repo`, если хотите загрузить локальный файл: в такой комбинации `--model` становится выбором файла внутри HF-репозитория.

## Влияние на производительность и память

Сам аргумент только выбирает файл, но выбранная модель определяет:

- объем RAM/VRAM под веса;
- время mmap/загрузки;
- требования к `--ctx-size`, KV-cache и `--parallel`;
- совместимость GPU offload, `--mmproj`, LoRA и control vectors.

Если `--mmap` включен, чтение локального файла может быть ленивым и зависеть от page cache. Для стабильной диагностики сравнивайте одинаковый файл, одинаковый backend и одинаковые параметры offload.

## Взаимодействие с другими аргументами

- `--hf-repo`: меняет смысл `--model` на `--hf-file`, если `--hf-file` не задан явно.
- `--hf-file`: явный выбор файла в HF-репозитории; при наличии `--hf-file` значение `--model` не переносится.
- `--model-url`: при пустом `--model` сам назначает путь в кэше; при непустом `--model` скачивает URL именно в этот путь.
- `--mmproj`: нужен для multimodal-моделей, если projector не найден автоматически через `--hf-repo`.
- `--lora` и `--control-vector`: должны соответствовать архитектуре и размерности базовой модели.
- `--models-dir` и `--models-preset`: в router-режиме модель может выбираться не прямым `--model`, а пресетом или каталогом.

## INI-пресеты и router-режим

В `--models-preset` ключ пишется без дефисов: `model = /abs/path/model.gguf`. По README router требует для кастомного пресета как минимум локальный `model` или HF-репозиторий.

Router наследует глобальные CLI/env параметры, но часть параметров модели контролирует сам при загрузке дочернего процесса. Для локальных GGUF из `--models-dir` объект в `/models` помечается как `"in_cache": false`.

## Типовые проблемы и диагностика

- `failed to load model`: проверьте путь, права пользователя процесса и что файл действительно GGUF.
- В логе указан не тот путь: проверьте, не задан ли `--hf-repo`, `--model-url` или `--docker-repo`.
- Модель не видна router-у: для `--models-dir` одиночные GGUF кладутся прямо в каталог, а multimodal/split модели - в подкаталоги.
- LoRA не грузится после смены модели: адаптер должен быть обучен под совместимую базовую модель.

## Примеры

```bash
llama-server --model /srv/models/Qwen3-8B-Q4_K_M.gguf
```

```bash
llama-server --model /srv/models/gemma-3-4b-it-Q8_0/gemma-3-4b-it-Q8_0.gguf --mmproj /srv/models/gemma-3-4b-it-Q8_0/mmproj-F16.gguf
```

```ini
[local_qwen]
model = /srv/models/Qwen3-8B-Q4_K_M.gguf
ctx-size = 8192
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
