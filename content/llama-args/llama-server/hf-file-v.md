---
schema: 1
primaryName: "--hf-file-v"
title: "--hf-file-v"
summary: "Выбирает конкретный GGUF-файл vocoder-модели внутри `--hf-repo-v`. Это точный путь файла в HF repo, а не локальный путь."
category: "Общие параметры"
valueType: "path"
valueHint: "FILE"
aliases:
  - "-hffv"
  - "--hf-file-v"
allowedValues: []
env:
  - "LLAMA_ARG_HF_FILE_V"
related:
  - "--hf-repo-v"
  - "--hf-token"
  - "--model-vocoder"
  - "--offline"
---

# --hf-file-v

## Кратко

`--hf-file-v` задает точный файл vocoder model в репозитории `--hf-repo-v`. Значение записывается в `common_params.vocoder.model.hf_file` и переопределяет quant tag в `--hf-repo-v`.

## Оригинальная справка llama.cpp

```text
Hugging Face model file for the vocoder model (default: unused)
```

## Паспорт аргумента

- Основное имя: `--hf-file-v`
- Алиасы: `-hffv`, `--hf-file-v`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `path`
- Подсказка формата из `--help`: `FILE`
- Переменные окружения: `LLAMA_ARG_HF_FILE_V`
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.vocoder.model.hf_file`

## Что меняет в llama-server

При обработке vocoder HF repo downloader ищет `model.hf_file` среди файлов repo по точному совпадению пути. Если файл найден, он скачивается в HF cache и становится `params.vocoder.model.path`. Если это split GGUF, остальные части добавляются автоматически.

Если файл не найден, логика такая же, как у основной `--hf-file`: ошибка `file '<name>' not found in repository` и список `Available GGUF files:`.

## Значения и формат

Указывайте путь файла внутри HF repo:

- `vocoder-Q4_K_M.gguf`
- `subdir/vocoder-Q8_0.gguf`
- `vocoder-00001-of-00002.gguf` для split GGUF

Локальные пути вида `/srv/models/vocoder.gguf` относятся к `--model-vocoder`, а не к `--hf-file-v`.

## Когда использовать

Используйте `--hf-file-v`, когда vocoder repo содержит несколько GGUF-файлов и нужно выбрать конкретный файл, а не полагаться на quant fallback.

## Влияние на производительность и память

Выбранный vocoder файл определяет размер дополнительной модели и память, нужную для аудио/TTS. Более крупный quant может улучшить качество, но увеличивает время старта и memory footprint.

## Взаимодействие с другими аргументами

- `--hf-repo-v`: должен указывать repo, внутри которого ищется файл.
- `--hf-token`: нужен для приватного/gated vocoder repo.
- `--offline`: файл должен быть уже в HF cache.
- `--model-vocoder`: локальная альтернатива, когда HF selector не нужен.

## INI-пресеты и router-режим

```ini
[tts_exact_vocoder]
hf-repo = owner/text-model-GGUF:Q4_K_M
hf-repo-v = owner/vocoder-GGUF
hf-file-v = vocoder-Q8_0.gguf
```

В router-режиме путь внутри repo должен быть стабильным для всех дочерних процессов, а cache должен быть доступен пользователю, от имени которого они запускаются.

## Типовые проблемы и диагностика

- `file '<name>' not found in repository`: имя не совпадает с HF path; используйте список `Available GGUF files:`.
- Vocoder не загружается в offline: сначала запустите online-прогрев cache или используйте локальный `--model-vocoder`.
- Основная модель загружается, аудио нет: проверьте, что вы указали `--hf-file-v`, а не обычный `--hf-file`.

## Примеры

```bash
llama-server --model /srv/models/text.gguf --hf-repo-v owner/vocoder-GGUF --hf-file-v vocoder-Q4_K_M.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
