---
schema: 1
primaryName: "--hf-repo"
title: "--hf-repo"
summary: "Выбирает основной GGUF из Hugging Face repo в формате `<user>/<model>[:quant]`. Downloader использует HF cache, умеет split GGUF и автоматически подбирает `mmproj`, если он найден и не отключен."
category: "Общие параметры"
valueType: "string"
valueHint: "<user>/<model>[:quant]"
aliases:
  - "-hf"
  - "-hfr"
  - "--hf-repo"
allowedValues: []
env:
  - "LLAMA_ARG_HF_REPO"
related:
  - "--hf-file"
  - "--hf-token"
  - "--offline"
  - "--cache-list"
  - "--mmproj-auto"
  - "--mmproj"
  - "--model"
---

# --hf-repo

## Кратко

`--hf-repo` задает Hugging Face repository для основной модели. Значение записывается в `common_params.model.hf_repo` и должно иметь формат `<user>/<model>[:quant]`, например `ggml-org/GLM-4.7-Flash-GGUF:Q4_K_M`.

При загрузке llama.cpp строит план скачивания: получает список файлов репозитория, выбирает GGUF по `--hf-file` или quant tag, скачивает все части split GGUF, а для server/mtmd автоматически ищет соседний `mmproj`, если `--no-mmproj` не задан.

## Оригинальная справка llama.cpp

```text
Hugging Face model repository; quant is optional, case-insensitive, default to Q4_K_M, or falls back to the first file in the repo if Q4_K_M doesn't exist.
mmproj is also downloaded automatically if available. to disable, add --no-mmproj
example: ggml-org/GLM-4.7-Flash-GGUF:Q4_K_M
(default: unused)
```

## Паспорт аргумента

- Основное имя: `--hf-repo`
- Алиасы: `-hf`, `-hfr`, `--hf-repo`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `<user>/<model>[:quant]`
- Переменные окружения: `LLAMA_ARG_HF_REPO`
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.model.hf_repo`

## Что меняет в llama-server

`common_download_split_repo_tag()` разбирает строку на repo и optional tag. Repo обязан состоять ровно из двух частей `owner/name`; иначе выбрасывается ошибка `invalid HF repo format, expected <user>/<model>[:quant]`.

Если `--hf-file` не задан, downloader выбирает модель так:

- если quant tag указан после `:`, ищет GGUF, имя которого содержит этот tag перед `.` или `-`, без учета регистра;
- если tag не указан, пробует `Q4_K_M`, затем `Q8_0`;
- если этих quant нет, берет первый доступный GGUF, кроме `mmproj`, `imatrix` и `mtp-`;
- для split GGUF выбирает shard `00001` и автоматически добавляет остальные shard-файлы с тем же prefix/count.

После скачивания `model.name` становится исходным HF repo, а `model.path` - локальным путем в HF cache. Если найден `mmproj` и `--mmproj`/`--mmproj-url` не заданы, `params.mmproj.path` заполняется автоматически, пока `--no-mmproj` не отключает это поведение.

## Значения и формат

Формат: `<user>/<model>[:quant]`.

- `ggml-org/gemma-3-4b-it-GGUF` - repo без quant, выбор по умолчанию;
- `ggml-org/gemma-3-4b-it-GGUF:Q8_0` - repo с quant tag;
- `:latest` имеет особый смысл для remote `preset.ini`: в коде он переводится в секцию `default` при обработке удаленного пресета.

`--hf-repo` не принимает URL. Для прямого URL используйте `--model-url`.

## Когда использовать

Используйте `--hf-repo`, когда модель опубликована как HF GGUF-репозиторий и вы хотите автоматический выбор quant, скачивание split-файлов и cache. Это предпочтительный вариант для HF-моделей по сравнению с прямым `--model-url`.

Для точного воспроизведения production-конфигурации лучше задавать либо quant tag, либо `--hf-file`, чтобы обновления состава repo не меняли выбранный файл неожиданно.

## Влияние на производительность и память

Первый старт может быть долгим из-за сетевого списка файлов и скачивания всех частей модели. После попадания в HF cache повторный старт использует локальные файлы. Размер выбранного quant напрямую влияет на RAM/VRAM, latency и максимальный `--ctx-size`.

Автоматически найденный `mmproj` добавляет отдельную загрузку и память для multimodal projector.

## Взаимодействие с другими аргументами

- `--hf-file`: имеет приоритет над quant tag и выбирает конкретный файл внутри repo.
- `--hf-token`: передается как bearer token для приватных/gated repo.
- `--offline`: запрещает сетевой список файлов и скачивание; выбор идет только по локальному HF cache.
- `--model`: если `--hf-file` пустой, значение `--model` переносится в `hf_file`.
- `--mmproj-auto`/`--no-mmproj`: включает или отключает автоматическое использование найденного projector.
- `--cache-list`: показывает repo:tag, найденные в HF cache, исключая `mmproj` и `mtp`.

## INI-пресеты и router-режим

В INI используйте `hf-repo = owner/name:Q4_K_M`. По README router умеет искать модели в cache и рекомендует добавлять HF-модели в cache командой `llama-server -hf <user>/<model>:<tag>`, после чего router нужно перезапустить.

Некоторые аргументы контролируются router-ом и могут удаляться или перезаписываться при загрузке дочернего процесса; HF repo и model alias прямо приведены в README как такие параметры.

## Типовые проблемы и диагностика

- `invalid HF repo format`: строка не вида `owner/repo`.
- `file '<name>' not found in repository`: `--hf-file` не совпадает с путем файла в repo.
- `no GGUF files found in repository`: repo не содержит подходящих GGUF или cache пустой в offline-режиме.
- В логах `Available GGUF files:`: используйте список для выбора корректного `--hf-file`.
- Multimodal не работает: проверьте, найден ли `mmproj`, не задан ли `--no-mmproj`, и есть ли строка `loaded multimodal model`.

## Примеры

```bash
llama-server --hf-repo ggml-org/GLM-4.7-Flash-GGUF:Q4_K_M
```

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --no-mmproj
```

```ini
[glm_flash_q4]
hf-repo = ggml-org/GLM-4.7-Flash-GGUF:Q4_K_M
ctx-size = 8192
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
- `llama.cpp/tools/server/README.md`
