---
schema: 1
primaryName: "--hf-token"
title: "--hf-token"
summary: "Передает Hugging Face access token downloader-у как bearer token. По умолчанию значение берется из переменной окружения `HF_TOKEN`."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "TOKEN"
aliases:
  - "-hft"
  - "--hf-token"
allowedValues: []
env:
  - "HF_TOKEN"
related:
  - "--hf-repo"
  - "--hf-file"
  - "--model-url"
  - "--offline"
---

# --hf-token

## Кратко

`--hf-token` задает access token для Hugging Face downloads. Значение записывается в `common_params.hf_token` и передается в `common_download_opts.bearer_token` при обработке основной модели, `mmproj` и draft model.

Переменная окружения для этого аргумента - `HF_TOKEN`, а не `LLAMA_ARG_HF_TOKEN`.

## Оригинальная справка llama.cpp

```text
Hugging Face access token (default: value from HF_TOKEN environment variable)
```

## Паспорт аргумента

- Основное имя: `--hf-token`
- Алиасы: `-hft`, `--hf-token`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `TOKEN`
- Переменные окружения: `HF_TOKEN`
- Значение по умолчанию: значение `HF_TOKEN`, если оно есть
- Внутреннее поле: `common_params.hf_token`

## Что меняет в llama-server

На этапе парсинга CLI токен сохраняется как строка. При скачивании HF repo `hf_cache::get_repo_files(repo, opts.bearer_token)` использует его для доступа к списку файлов, а `common_download_file_single()` получает тот же bearer token для загрузки файлов.

Тот же token передается и для `--model-url`; это может помочь только для серверов, которые ожидают Bearer auth. Для Docker Hub `--docker-repo` используется отдельный Docker registry token, не `--hf-token`.

## Значения и формат

Ожидается raw token строкой. Не добавляйте префикс `Bearer `: код хранит именно token и сам формирует auth там, где это нужно.

В конфигурациях arriero токен лучше хранить как секрет, а не как обычный параметр с логированием. CLI-аргумент может быть виден в process list; переменная окружения `HF_TOKEN` обычно безопаснее для управляемого сервиса.

## Когда использовать

Используйте `--hf-token` или `HF_TOKEN`, когда HF repo приватный, gated или требует принятой лицензии. Для публичных repo токен не нужен.

Не передавайте токен в публично доступные пресеты, логи, issue reports и shared shell history.

## Влияние на производительность и память

На runtime inference токен не влияет. Он влияет только на успешность и скорость старта, если без токена HF API возвращает ошибку или пустой список файлов. После того как файлы есть в cache, `--offline` может запускаться без сетевых обращений.

## Взаимодействие с другими аргументами

- `--hf-repo` и `--hf-file`: основной потребитель токена.
- `--mmproj-url`/`--model-url`: token попадет в общие download options, если используется URL-скачивание.
- `--offline`: при offline-режиме токен не вызывает сетевых запросов; требуются уже закэшированные файлы.

## INI-пресеты и router-режим

В INI технически можно указать `hf-token = ...` или `HF_TOKEN = ...`, потому что preset parser поддерживает имена аргументов и env keys. Практически лучше задавать секрет через окружение процесса router/дочернего `llama-server`, чтобы не хранить token в файле пресета.

## Типовые проблемы и диагностика

- Repo публичный работает, приватный нет: проверьте `HF_TOKEN` у пользователя процесса.
- В логе доступных файлов пусто или `no GGUF files found`: token может не иметь доступа к repo.
- Случайная утечка: проверьте systemd unit, shell history, UI audit logs и сохраненные пресеты.

## Примеры

```bash
HF_TOKEN=hf_xxx llama-server --hf-repo owner/private-GGUF:Q4_K_M
```

```bash
llama-server --hf-token hf_xxx --hf-repo owner/private-GGUF --hf-file model-Q4_K_M.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
