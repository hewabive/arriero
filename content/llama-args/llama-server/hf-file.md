---
schema: 1
primaryName: "--hf-file"
title: "--hf-file"
summary: "Выбирает конкретный файл внутри `--hf-repo` и тем самым переопределяет quant tag. Значение должно совпадать с путем файла в Hugging Face repo."
category: "Общие параметры"
valueType: "path"
estimation: "normal"
valueHint: "FILE"
aliases:
  - "-hff"
  - "--hf-file"
allowedValues: []
env:
  - "LLAMA_ARG_HF_FILE"
related:
  - "--hf-repo"
  - "--hf-token"
  - "--offline"
  - "--model"
---

# --hf-file

## Кратко

`--hf-file` задает точный файл модели внутри Hugging Face repository, указанного через `--hf-repo`. Значение записывается в `common_params.model.hf_file` и при выборе primary GGUF имеет приоритет над quant tag в `--hf-repo`.

Это путь внутри репозитория, а не локальный filesystem path. Например: `subdir/model-Q5_K_M.gguf`.

## Оригинальная справка llama.cpp

```text
Hugging Face model file. If specified, it will override the quant in --hf-repo (default: unused)
```

## Паспорт аргумента

- Основное имя: `--hf-file`
- Алиасы: `-hff`, `--hf-file`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `path`
- Подсказка формата из `--help`: `FILE`
- Переменные окружения: `LLAMA_ARG_HF_FILE`
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.model.hf_file`

## Что меняет в llama-server

В `get_hf_plan()` при непустом `model.hf_file` downloader перебирает список файлов repo и ищет точное совпадение `f.path == model.hf_file`. Если файл найден, он становится primary model. Если это первый shard split GGUF, `get_split_files()` добавляет остальные части.

Если файл не найден, llama.cpp логирует `file '<name>' not found in repository`, печатает `Available GGUF files:` и загрузка HF-модели завершается ошибкой.

## Значения и формат

Указывайте путь так, как он хранится в HF repo. Для файла в корне это просто имя, например `model-Q4_K_M.gguf`; для подкаталога - `folder/model-Q4_K_M.gguf`.

Для split GGUF указывайте первый shard `...-00001-of-000NN.gguf`. Остальные shard-файлы будут найдены по совпадающему prefix/count.

## Когда использовать

Используйте `--hf-file`, когда:

- в repo несколько моделей с одинаковым quant tag;
- нужен файл в подкаталоге;
- вы хотите защититься от изменения эвристики выбора `Q4_K_M`/`Q8_0`/first GGUF;
- quant tag в имени файла не соответствует простому `:Q...` selector.

## Влияние на производительность и память

Аргумент сам не меняет runtime-параметры, но выбранный файл определяет quant, размер, скорость загрузки, RAM/VRAM и качество. Ошибочный выбор более крупного файла может привести к OOM уже на старте.

## Взаимодействие с другими аргументами

- `--hf-repo`: обязателен для осмысленного применения `--hf-file`.
- `--model`: если `--hf-repo` задан, а `--hf-file` пустой, `--model` автоматически переносится в `hf_file`; явный `--hf-file` исключает эту подстановку.
- `--offline`: файл должен быть представлен в локальном HF cache, иначе план не соберется.
- `--mmproj-auto`: после выбора primary model автоматический поиск `mmproj` ищет sibling относительно выбранного файла.

## INI-пресеты и router-режим

В INI:

```ini
[hf_exact_file]
hf-repo = ggml-org/example-GGUF
hf-file = subdir/model-Q5_K_M.gguf
```

В router-режиме точный file selector полезен для стабильного выбора модели, но сам HF repo может контролироваться router-ом при загрузке дочернего процесса.

## Типовые проблемы и диагностика

- Ошибка `file '<name>' not found in repository`: скопируйте имя из блока `Available GGUF files:`.
- Указан локальный `/srv/models/model.gguf`: для локального файла используйте `--model`, а не `--hf-file`.
- Split GGUF скачался не полностью: проверьте, что в repo есть все части с одинаковым `000NN-of-000MM`.

## Примеры

```bash
llama-server --hf-repo ggml-org/example-GGUF --hf-file model-Q5_K_M.gguf
```

```bash
llama-server --hf-repo ggml-org/example-GGUF --hf-file subdir/model-00001-of-00003.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
