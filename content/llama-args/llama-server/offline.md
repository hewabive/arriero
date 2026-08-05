---
schema: 1
primaryName: "--offline"
title: "--offline"
summary: "Запрещает сетевые обращения общего downloader-а и заставляет использовать уже подготовленный cache. Применяется к HF/URL downloads, включая `mmproj` и draft-модели."
category: "Общие параметры"
valueType: "flag"
valueHint: null
aliases:
  - "--offline"
allowedValues: []
env:
  - "LLAMA_ARG_OFFLINE"
related:
  - "--hf-repo"
  - "--hf-file"
  - "--model-url"
  - "--mmproj-url"
  - "--cache-list"
---

# --offline

## Кратко

`--offline` выставляет `common_params.offline = true`. Общий downloader не делает сетевых запросов и принимает только файлы, которые уже существуют в ожидаемом cache/local path.

Это полезно для production, air-gapped и воспроизводимых запусков, но требует заранее прогретого cache.

## Оригинальная справка llama.cpp

```text
Offline mode: forces use of cache, prevents network access
```

## Паспорт аргумента

- Основное имя: `--offline`
- Алиасы: `--offline`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Переменные окружения: `LLAMA_ARG_OFFLINE`
- Значение по умолчанию: disabled
- Внутреннее поле: `common_params.offline`

## Что меняет в llama-server

`common_params_handle_models()` передает `params.offline` в обработку:

- основной модели;
- `mmproj`;
- speculative draft model;

В `common_download_file_single()` offline-режим проверяет только `std::filesystem::exists(path)`. Если файла нет, логируется `required file is not available in cache (offline mode)` и возвращается ошибка. Если файл есть, возвращается fake status `304` как cached response.

Для HF repo при offline сначала не запрашивается список файлов из сети; downloader использует `hf_cache::get_cached_files(repo)`.

## Значения и формат

Это флаг без значения. Парной `--no-offline` формы в проверенном коде нет.

## Когда использовать

Используйте после того, как все нужные модели, split shards, `mmproj` и draft-файлы уже скачаны и доступны пользователю процесса. Это хороший production-default для инстансов, которые не должны зависеть от внешних сервисов.

Не используйте для первого запуска HF/URL модели, если cache еще пуст.

## Влияние на производительность и память

Offline уменьшает вариативность старта: нет сетевого API/listing/download. На inference memory/latency не влияет. Если cache лежит на медленном диске, время загрузки все равно определяется локальным I/O.

## Взаимодействие с другими аргументами

- `--hf-repo`/`--hf-file`: работают только если HF cache содержит repo files metadata/файлы.
- `--model-url`/`--mmproj-url`: требуют существующий локальный файл по рассчитанному или заданному пути.
- `--hf-token`: не вызывает сеть в offline, но может оставаться в конфигурации без эффекта.
- `--docker-repo`: в проверенном коде Docker resolver не получает `params.offline`, поэтому для строгого offline используйте локальный `--model`, а не Docker repo.
- `--cache-list`: помогает увидеть HF-модели, доступные из cache.

## INI-пресеты и router-режим

```ini
[*]
offline = true

[cached_hf]
hf-repo = ggml-org/example-GGUF:Q4_K_M
```

В router-режиме cache должен быть доступен как router-процессу, так и дочерним model processes. README отмечает, что router по умолчанию ищет модели в cache.

## Типовые проблемы и диагностика

- `required file is not available in cache (offline mode)`: прогрейте cache online или укажите локальный `--model`.
- HF repo не находится, хотя файл есть на диске: cache должен быть в формате HF cache, а не произвольный каталог; для произвольного каталога используйте `--models-dir` или `--model`.
- URL download в offline не работает: укажите тот же локальный путь через `--model`/`--mmproj`, куда файл был скачан.

## Примеры

```bash
llama-server --hf-repo ggml-org/example-GGUF:Q4_K_M --offline
```

```bash
llama-server --model /srv/models/model.gguf --mmproj /srv/models/mmproj-F16.gguf --offline
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
- `llama.cpp/tools/server/README.md`
