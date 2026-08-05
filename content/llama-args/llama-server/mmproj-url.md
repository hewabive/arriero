---
schema: 1
primaryName: "--mmproj-url"
title: "--mmproj-url"
summary: "Скачивает multimodal projector по прямому URL и затем использует локальную копию как `--mmproj`. Для строгого воспроизведения лучше закреплять локальный путь через `--mmproj`."
category: "Параметры llama-server"
valueType: "string"
estimation: "remote-mmproj"
valueHint: "URL"
aliases:
  - "-mmu"
  - "--mmproj-url"
allowedValues: []
env:
  - "LLAMA_ARG_MMPROJ_URL"
related:
  - "--mmproj"
  - "--mmproj-auto"
  - "--mmproj-offload"
  - "--model-url"
  - "--offline"
---

# --mmproj-url

## Кратко

`--mmproj-url` задает прямой URL для скачивания multimodal projector. Значение записывается в `common_params.mmproj.url`; затем `common_params_handle_model(params.mmproj, ...)` скачивает файл и заполняет `mmproj.path`.

Используйте этот аргумент только для одного прямого файла projector. Для HF repo с auto-поиском projector чаще достаточно `--hf-repo`.

## Оригинальная справка llama.cpp

```text
URL to a multimodal projector file. see tools/mtmd/README.md
```

## Паспорт аргумента

- Основное имя: `--mmproj-url`
- Алиасы: `-mmu`, `--mmproj-url`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `URL`
- Переменные окружения: `LLAMA_ARG_MMPROJ_URL`
- Значение по умолчанию: пусто
- Внутреннее поле: `common_params.mmproj.url`

## Что меняет в llama-server

`--mmproj-url` участвует в общем download pipeline для `common_params_model`. Если `mmproj.path` пустой, локальное имя берется из последнего сегмента URL после удаления query string и fragment. После успешного скачивания server загружает projector так же, как при явном `--mmproj`.

В отличие от `--hf-repo`, прямой URL не выполняет поиск совместимого projector и не проверяет repo-соседство с основной моделью.

## Значения и формат

Ожидается URL на GGUF projector. Если URL не заканчивается понятным именем файла или содержит signed query, лучше одновременно задать `--mmproj /abs/path/mmproj.gguf`, чтобы контролировать имя локальной копии.

## Когда использовать

Используйте `--mmproj-url`, когда projector опубликован как отдельный артефакт по прямому URL. Для production лучше один раз скачать файл и затем использовать локальный `--mmproj`, чтобы не зависеть от сети и ETag.

## Влияние на производительность и память

Первый старт включает скачивание projector. После загрузки runtime-влияние такое же, как у `--mmproj`: дополнительная память и preprocessing для multimodal inputs.

## Взаимодействие с другими аргументами

- `--mmproj`: если задан, может использоваться как путь назначения для URL download.
- `--offline`: требует уже существующий локальный файл по рассчитанному или заданному пути.
- `--mmproj-auto`: не нужен для явного URL; `--no-mmproj` очищает `params.mmproj` после обработки основной модели.
- `--hf-token`: bearer token попадает в download options, если сервер URL его принимает.

## INI-пресеты и router-режим

```ini
[vision_url_projector]
model = /srv/models/vision.gguf
mmproj = /srv/models/mmproj.gguf
mmproj-url = https://example.org/mmproj-F16.gguf
```

В router-режиме прямой URL может замедлять lazy load модели. Для стабильного router лучше держать projector локально рядом с моделью.

## Типовые проблемы и диагностика

- `required file is not available in cache (offline mode)`: включен `--offline`, но projector не скачан.
- `failed to load multimodal model`: URL скачал не тот файл, HTML error page или несовместимый projector.
- Projector скачивается при каждом изменении URL query: закрепите локальный `--mmproj`.

## Примеры

```bash
llama-server --model /srv/models/vision.gguf --mmproj-url https://example.org/mmproj-F16.gguf
```

```bash
llama-server --model /srv/models/vision.gguf --mmproj /srv/models/mmproj-F16.gguf --mmproj-url https://example.org/download/mmproj
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/tools/server/server-context.cpp`
