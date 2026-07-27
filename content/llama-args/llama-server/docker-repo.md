---
schema: 1
primaryName: "--docker-repo"
title: "--docker-repo"
summary: "Загружает GGUF-слой из Docker Hub model repository и подставляет скачанный файл как основную модель. Если namespace не указан, используется `ai/`, а tag по умолчанию - `latest`."
category: "Общие параметры"
valueType: "string"
valueHint: "[<repo>/]<model>[:quant]"
aliases:
  - "-dr"
  - "--docker-repo"
allowedValues: []
env:
  - "LLAMA_ARG_DOCKER_REPO"
related:
  - "--model"
  - "--model-url"
  - "--hf-repo"
  - "--offline"
---

# --docker-repo

## Кратко

`--docker-repo` выбирает модель из Docker Hub. Значение записывается в `common_params.model.docker_repo`; при обработке модели llama.cpp вызывает `common_docker_resolve_model()`, скачивает GGUF layer из OCI/Docker manifest и заменяет `model.path` локальным файлом в cache.

Этот аргумент рассчитан именно на Docker Hub model artifacts с GGUF-слоем. Он не запускает контейнер и не использует локальный Docker daemon.

## Оригинальная справка llama.cpp

```text
Docker Hub model repository. repo is optional, default to ai/. quant is optional, default to :latest.
example: gemma3
(default: unused)
```

## Паспорт аргумента

- Основное имя: `--docker-repo`
- Алиасы: `-dr`, `--docker-repo`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `[<repo>/]<model>[:quant]`
- Переменные окружения: `LLAMA_ARG_DOCKER_REPO`
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.model.docker_repo`

## Что меняет в llama-server

При непустом `model.docker_repo` функция `common_params_handle_model()` обрабатывает Docker-источник первой, раньше `--hf-repo` и `--model-url`. После успешной загрузки:

- `model.path` становится локальным cache-файлом;
- `model.name` получает исходное значение Docker repo;
- основной сервер дальше грузит модель как обычный локальный GGUF.

`common_docker_resolve_model()` получает токен Docker Hub, запрашивает manifest, ищет layer с media type `application/vnd.docker.ai.gguf.v3` или содержащим `gguf`, валидирует `sha256:<64 hex>`, скачивает blob и кладет файл с именем вида `<repo>_<tag>.gguf`, где `/` заменены на `_`.

## Значения и формат

Формат: `[<repo>/]<model>[:quant]`.

- `gemma3` превращается в repo `ai/gemma3` и tag `latest`;
- `ai/smollm2:135M-Q4_0` использует repo `ai/smollm2`, tag `135M-Q4_0`;
- если `:tag` не указан, используется `latest`.

Пробелы и shell-экранирование не обрабатываются специально: передавайте значение отдельным argv-элементом.

## Когда использовать

Используйте `--docker-repo`, если модель распространяется через Docker Hub как OCI artifact с GGUF layer и вы хотите единый способ доставки без ручного URL. Для локального production-запуска после первичной загрузки часто проще закрепить получившийся путь через `--model`.

Не используйте этот аргумент для приватных registry или non-Docker-Hub источников: текущая реализация жестко обращается к `auth.docker.io` и `registry-1.docker.io`.

## Влияние на производительность и память

Первый старт зависит от Docker Hub API, размера blob и скорости диска. После скачивания производительность инференса определяется выбранной GGUF-моделью.

В отличие от HF/download path, Docker resolver в этом commit не получает `params.offline`: `--offline` не предотвращает сетевые обращения Docker resolver. Для строгого offline режима используйте заранее скачанный локальный `--model`.

## Взаимодействие с другими аргументами

- `--model`: при заданном `--docker-repo` не является источником модели; Docker resolver перезаписывает `model.path`.
- `--hf-repo` и `--model-url`: не используются, если `--docker-repo` непустой, потому что Docker ветка стоит первой.
- `--offline`: не применяется к Docker resolver в проверенном коде.
- `--mmproj`: Docker resolver скачивает только основной GGUF layer; projector задавайте отдельно.

## INI-пресеты и router-режим

В INI ключ пишется как `docker-repo = ai/smollm2:135M-Q4_0`. Для router-пресетов учитывайте, что дочерний процесс будет обращаться в Docker Hub при загрузке модели. Если это нежелательно, заранее скачайте модель и укажите `model = /abs/path/file.gguf`.

## Типовые проблемы и диагностика

- `Failed to get Docker registry token`: проблема доступа к Docker Hub auth.
- `Failed to get Docker manifest`: repo/tag не существует или недоступен.
- `No GGUF layer found in Docker manifest`: artifact не содержит GGUF-слой.
- `Invalid OCI digest format received in manifest`: manifest вернул digest не в ожидаемом `sha256` формате.
- `Failed to download Docker Model`: blob не скачался или HTTP-статус неуспешный.

## Примеры

```bash
llama-server --docker-repo gemma3
```

```bash
llama-server --docker-repo ai/smollm2:135M-Q4_0
```

```ini
[docker_smollm]
docker-repo = ai/smollm2:135M-Q4_0
ctx-size = 4096
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
