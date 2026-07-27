---
schema: 1
primaryName: "--spec-type"
title: "--spec-type"
summary: "Выбирает реализации speculative decoding: обычную draft-модель, EAGLE-3, MTP, DFlash или n-gram варианты. Значение задаётся списком через запятую."
category: "Параметры speculative decoding"
valueType: "list"
valueHint: "none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache"
aliases:
  - "--spec-type"
allowedValues:
  - "none"
  - "draft-simple"
  - "draft-eagle3"
  - "draft-mtp"
  - "draft-dflash"
  - "ngram-simple"
  - "ngram-map-k"
  - "ngram-map-k4v"
  - "ngram-mod"
  - "ngram-cache"
env:
  - "LLAMA_ARG_SPEC_TYPE"
related:
  - "--spec-draft-model"
  - "--spec-draft-hf"
  - "--spec-draft-n-max"
  - "--spec-draft-n-min"
  - "--spec-draft-p-min"
  - "--spec-ngram-simple-size-n"
  - "--spec-ngram-map-k-size-n"
  - "--spec-ngram-mod-n-max"
---

# --spec-type

## Кратко

`--spec-type` задает список speculative decoding реализаций, которые `llama-server` попробует использовать для ускорения генерации. Значение записывается в `common_params.speculative.types`; парсер разбивает строку по запятым и преобразует имена в `common_speculative_type`.

По умолчанию активен только `none`, то есть speculative decoding не включается. Для HF draft repo llama.cpp может вывести тип из найденного `mtp-`, `dflash-` или `eagle3-` sidecar. Для локальной обычной draft-модели задавайте `--spec-type draft-simple` явно.

## Оригинальная справка llama.cpp

```text
none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache comma-separated list of types of speculative decoding to use (default: none)
```

## Паспорт аргумента

- Основное имя: `--spec-type`
- Значение: список имен через запятую без пробелов, например `draft-simple,ngram-map-k`
- Структура llama.cpp: `common_params.speculative.types`
- Переменная окружения: `LLAMA_ARG_SPEC_TYPE`
- Значение по умолчанию: `none`
- Этап применения: парсинг CLI/env, затем создание speculative-контекста после загрузки target и draft/MTP контекстов

## Что меняет в llama-server

При старте сервера `common_speculative_init()` строит набор реализаций и порядок их попыток. В текущем commit приоритет такой: `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache`, затем `draft-simple`, `draft-eagle3`, `draft-mtp`, `draft-dflash`.

`draft-simple`, `draft-eagle3` и `draft-dflash` используют отдельную совместимую draft-модель. `draft-mtp` может использовать MTP-контекст target-модели. При `--hf-repo` llama.cpp умеет автоматически найти MTP-, EAGLE-3- или DFlash-sidecar рядом с основной моделью. N-gram варианты draft-модель не требуют.

## Значения и формат

- `none` - speculative decoding выключен.
- `draft-simple` - классический speculative decoding через отдельную draft-модель.
- `draft-eagle3` - autoregressive EAGLE-3 draft model, обученная под конкретную target-модель.
- `draft-mtp` - speculative decoding через MTP-контекст.
- `draft-dflash` - block-diffusion draft model, которая выдаёт блок токенов за один forward pass и использует hidden states target-модели.
- `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache` - self-speculative варианты на истории токенов/ngram-cache.

Неизвестное имя приводит к ошибке `unknown speculative type: ...`. Повторный `--spec-type` в CLI не вызывает deprecated-warning, но значения добавляются к уже накопленному списку; в arriero лучше хранить один список.

## Когда использовать

Используйте `draft-simple`, когда есть маленькая обычная draft-модель с тем же tokenizer/vocab, что и target. `draft-eagle3` и `draft-dflash` требуют sidecar, обученный под конкретную target-модель. Используйте `draft-mtp`, когда target GGUF содержит MTP-голову или рядом доступен MTP draft. N-gram варианты полезны без дополнительной модели, особенно на повторяющихся промптах и коде.

Для первого включения начните с одного типа, проверьте логи и метрику acceptance, затем добавляйте второй тип. Смешивание типов имеет смысл только если понятно, какой из них реально генерирует draft.

## Влияние на производительность и память

Draft-модель и MTP-контекст увеличивают время старта и память: отдельная модель добавляет веса, KV-cache и compute buffers; MTP добавляет отдельный контекст. DFlash также извлекает target-layer features и ограничивает `--spec-draft-n-max` размером блока, записанным в metadata draft-модели. N-gram варианты в основном добавляют CPU-работу и структуры истории/cache.

Ускорение зависит от `draft acceptance`: если acceptance низкий, сервер тратит время на генерацию и откат draft-токенов без выигрыша. В логах завершения слота смотрите строку `draft acceptance = ...`, а при старте - `adding speculative implementation ...`.

## Взаимодействие с другими аргументами

`--spec-draft-model` и `--spec-draft-hf` задают источник отдельной draft-модели. `--spec-draft-n-max`, `--spec-draft-n-min` и `--spec-draft-p-min` ограничивают длину и confidence для draft-model/MTP вариантов. `--spec-draft-type-k` и `--spec-draft-type-v` задают KV-cache draft/MTP контекста.

`--parallel` важен для draft-модели: `draft-simple` проверяет, что число последовательностей draft-контекста совпадает с `n_seq` speculative-системы. Если target-контекст не поддерживает нужное удаление последовательностей, сервер может вывести `speculative decoding not supported by this context` или использовать checkpoints.

## INI-пресеты и router-режим

В `--models-preset` используйте ключ без префикса `--`, например `spec-type = draft-simple` или `spec-type = ngram-simple,ngram-map-k`. README для router-пресетов показывает, что аргументы llama.cpp можно задавать в INI, а пути в пресете относительны к CWD сервера.

Router управляет некоторыми параметрами модели и доступа при загрузке модели. Speculative параметры не перечислены в README как router-controlled, но для draft-модели в пресете лучше использовать абсолютные пути, чтобы subprocess не зависел от текущего каталога.

## Типовые проблемы и диагностика

- `unknown speculative type`: в списке есть опечатка или пробел после запятой.
- `draft model is not specified - cannot use 'draft' type`: включен `draft-simple`, но не задана draft-модель.
- Draft-модель загружена, но speculative implementation не появляется в логах: проверьте, что `--spec-type` соответствует формату sidecar; для обычной локальной draft-модели нужен `draft-simple`.
- `failed to initialize speculative decoding context`: смотрите следующую ошибку, чаще всего это несовместимый vocab, отсутствие MTP-контекста или неподходящий backend.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple
```

```bash
llama-server --model /models/target.gguf --spec-type ngram-simple
```

```bash
llama-server --hf-repo ggml-org/example-GGUF --spec-type draft-mtp
```

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/dflash.gguf --spec-type draft-dflash --spec-draft-n-max 15
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/22105
