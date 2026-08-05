---
schema: 1
primaryName: "--hf-repo-v"
title: "--hf-repo-v"
summary: "Выбирает Hugging Face repo для vocoder-модели. Формат и cache-поведение такие же, как у `--hf-repo`, но значение пишется в `params.vocoder.model`; llama-server скачанный vocoder не загружает — он нужен только llama-tts."
category: "Общие параметры"
valueType: "string"
estimation: "normal"
valueHint: "<user>/<model>[:quant]"
aliases:
  - "-hfv"
  - "-hfrv"
  - "--hf-repo-v"
allowedValues: []
env:
  - "LLAMA_ARG_HF_REPO_V"
related:
  - "--hf-file-v"
  - "--hf-token"
  - "--model-vocoder"
  - "--offline"
---

# --hf-repo-v

## Кратко

`--hf-repo-v` задает HF repository для vocoder model. Значение записывается в `common_params.vocoder.model.hf_repo`, а затем обрабатывается тем же `common_params_handle_model()`, что и основная модель.

Суффикс `-v` означает vocoder, а не verbose и не vision. Для основного LLM используйте `--hf-repo`.

`llama-server` при этом только скачивает и резолвит файл: серверный код vocoder не загружает и TTS endpoint не предоставляет — модель нужна отдельному инструменту `llama-tts`. Подробности — в документе `--model-vocoder`.

## Оригинальная справка llama.cpp

```text
Hugging Face model repository for the vocoder model (default: unused)
```

## Паспорт аргумента

- Основное имя: `--hf-repo-v`
- Алиасы: `-hfv`, `-hfrv`, `--hf-repo-v`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `string`
- Подсказка формата из `--help`: `<user>/<model>[:quant]`
- Переменные окружения: `LLAMA_ARG_HF_REPO_V`
- Значение по умолчанию: не используется
- Внутреннее поле: `common_params.vocoder.model.hf_repo`

## Что меняет в llama-server

При `common_params_handle_models()` vocoder model обрабатывается после основной модели, `mmproj` и speculative draft model:

```text
common_params_handle_model(params.vocoder.model, params.hf_token, params.offline)
```

Это означает тот же механизм HF cache, token, offline и выбора файла, но результат попадает в `params.vocoder.model.path`, а не в основной `params.model.path`.

## Значения и формат

Формат такой же, как у `--hf-repo`: `<user>/<model>[:quant]`. Если `--hf-file-v` не задан, downloader выбирает GGUF по quant tag или fallback-эвристике `Q4_K_M`, затем `Q8_0`, затем первый подходящий GGUF.

## Когда использовать

Используйте `--hf-repo-v`, если vocoder GGUF распространяется через HF и должен скачиваться автоматически. Для уже скачанного локального файла используйте `--model-vocoder`.

Не путайте vocoder model с `mmproj`: `mmproj` нужен для multimodal projector, vocoder - для аудио generation/TTS pipeline.

## Влияние на производительность и память

Для `llama-server` затраты сводятся к скачиванию: время старта при холодном HF cache и место на диске. Память инстанса не меняется — сервер vocoder не загружает. В `llama-tts` размер и quant выбранного GGUF определяют footprint второй модели и latency аудио-генерации.

## Взаимодействие с другими аргументами

- `--hf-file-v`: выбирает точный файл внутри vocoder repo и переопределяет quant tag.
- `--hf-token`: используется для приватных/gated vocoder repo.
- `--model-vocoder`: локальная альтернатива HF repo; если задан HF repo, путь vocoder может быть заполнен скачанной копией.
- `--offline`: требует, чтобы vocoder файлы уже были в HF cache.
- `--tts-use-guide-tokens`: отдельный TTS-флаг, который может использоваться вместе с vocoder.

## INI-пресеты и router-режим

В INI:

```ini
[tts_model]
hf-repo = owner/text-model-GGUF:Q4_K_M
hf-repo-v = owner/vocoder-GGUF:Q4_K_M
```

Для router-режима учитывайте, что дочерний процесс должен иметь доступ к HF cache и `HF_TOKEN`, если repo закрытый.

## Типовые проблемы и диагностика

- `invalid HF repo format`: проверьте формат `owner/repo`.
- `no GGUF files found in repository`: vocoder repo не содержит подходящего GGUF или cache пустой при `--offline`.
- Ожидаете аудио-выход от `llama-server`: сервер vocoder не использует; audio input идет через `--mmproj`, речевая генерация — через `llama-tts`.

## Примеры

```bash
llama-server --model /srv/models/text.gguf --hf-repo-v owner/vocoder-GGUF:Q4_K_M
```

```bash
llama-server --hf-repo owner/text-GGUF:Q4_K_M --hf-repo-v owner/vocoder-GGUF --hf-file-v vocoder-Q8_0.gguf
```

## Статус в upstream

Upstream [PR #26254](https://github.com/ggml-org/llama.cpp/pull/26254) убирает серверные vocoder-аргументы; после обновления checkout за эту точку документ будет удален по штатной процедуре. См. `--model-vocoder`.

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/download.cpp`
- `llama.cpp/tools/server/README.md`
