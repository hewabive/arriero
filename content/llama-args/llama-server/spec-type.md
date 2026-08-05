---
schema: 1
primaryName: "--spec-type"
title: "--spec-type"
summary: "Выбирает реализации speculative decoding: обычную draft-модель, EAGLE-3, MTP, DFlash, DSpark или n-gram варианты. Значение задаётся списком через запятую."
category: "Параметры speculative decoding"
valueType: "list"
valueHint: "none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache"
aliases:
  - "--spec-type"
allowedValues:
  - "none"
  - "draft-simple"
  - "draft-eagle3"
  - "draft-mtp"
  - "draft-dflash"
  - "draft-dspark"
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
none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache comma-separated list of types of speculative decoding to use (default: none)
```

## Паспорт аргумента

- Основное имя: `--spec-type`
- Значение: список имен через запятую без пробелов, например `draft-simple,ngram-map-k`
- Структура llama.cpp: `common_params.speculative.types`
- Переменная окружения: `LLAMA_ARG_SPEC_TYPE`
- Значение по умолчанию: `none`
- Этап применения: парсинг CLI/env, затем создание speculative-контекста после загрузки target и draft/MTP контекстов

## Что меняет в llama-server

При старте сервера `common_speculative_init()` строит набор реализаций и порядок их попыток. В текущем commit приоритет такой: `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache`, затем `draft-simple`, `draft-eagle3`, `draft-mtp`, `draft-dflash`, `draft-dspark`.

`draft-simple`, `draft-eagle3`, `draft-dflash` и `draft-dspark` используют отдельную совместимую draft-модель. `draft-mtp` может использовать MTP-контекст target-модели. При `--hf-repo` llama.cpp умеет автоматически найти MTP-, EAGLE-3- или DFlash-sidecar рядом с основной моделью; для DSpark автоопределения нет, `--spec-type draft-dspark` задаётся явно. N-gram варианты draft-модель не требуют.

Arriero не оценивает remote selector до его разрешения. Поэтому для локального target `draft-simple`, `draft-eagle3`, `draft-dflash` и `draft-dspark` требуют существующий локальный `--spec-draft-model`; без него API оценки отвечает 422 вместо числа для конфигурации, которую текущий сервер не сможет инициализировать. `draft-mtp` остается исключением, поскольку может использовать embedded MTP target-модели.

## Значения и формат

- `none` - speculative decoding выключен.
- `draft-simple` - классический speculative decoding через отдельную draft-модель.
- `draft-eagle3` - autoregressive EAGLE-3 draft model, обученная под конкретную target-модель.
- `draft-mtp` - speculative decoding через MTP-контекст.
- `draft-dflash` - block-diffusion draft model, которая выдаёт блок токенов за один forward pass и использует hidden states target-модели.
- `draft-dspark` - DFlash-backbone плюс низкоранговая Markov-голова: логиты каждой позиции блока смещаются членом, зависящим от предыдущего токена, что возвращает часть left-to-right сигнала, теряемого чистой block-diffusion. Реализация наследует DFlash и переопределяет только генерацию draft.
- `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache` - self-speculative варианты на истории токенов/ngram-cache.

Неизвестное имя приводит к ошибке `unknown speculative type: ...`. Повторный `--spec-type` в CLI не вызывает deprecated-warning, но значения добавляются к уже накопленному списку; в arriero лучше хранить один список.

## Когда использовать

Используйте `draft-simple`, когда есть маленькая обычная draft-модель с тем же tokenizer/vocab, что и target. `draft-eagle3`, `draft-dflash` и `draft-dspark` требуют sidecar, обученный под конкретную target-модель. DSpark-чекпоинт (например `deepseek-ai/dspark_qwen3_4b_block7` для `Qwen/Qwen3-4B`) конвертируется с `--target-model-dir`, чтобы унаследовать tokenizer и token embeddings target-модели. Используйте `draft-mtp`, когда target GGUF содержит MTP-голову или рядом доступен MTP draft. N-gram варианты полезны без дополнительной модели, особенно на повторяющихся промптах и коде.

Для первого включения начните с одного типа, проверьте логи и метрику acceptance, затем добавляйте второй тип. Смешивание типов имеет смысл только если понятно, какой из них реально генерирует draft.

## Влияние на производительность и память

Draft-модель и MTP-контекст увеличивают время старта и память: отдельная модель добавляет веса, KV-cache и compute buffers; MTP добавляет отдельный контекст. DFlash также извлекает target-layer features и ограничивает `--spec-draft-n-max` размером блока (ключ metadata `dflash.block_size`, default 16). Тот же лимит действует для DSpark, но потолок на один токен выше: DFlash отдаёт максимум `block_size - 1` draft-токенов, DSpark — полный `block_size`, так как позиция 0 блока уже предсказывает первый токен. Превышение лимита не ошибка: сервер печатает `requested draft size ... exceeds the trained block size` и обрезает значение.

Arriero аппаратно квалифицировало обычный однослойный Qwen NextN, embedded MTP и Gemma shared-KV assistant. Текущие архитектуры Step 3.5 (`step35`), MiMo2 (`mimo2`) и Hy3 (`hy_v3`) используют семейно-специфичные multi-head/fused-QKV/iSWA MTP-графы. Для них известные веса и KV включаются, но оценка получает `low` confidence с явным предупреждением, пока полный второй контекст не измерен на подходящем оборудовании.

N-gram варианты не добавляют GGUF, но имеют разные host allocations: `ngram-simple` не держит fixed table; `ngram-mod` держит общий 16 MiB token table; `ngram-map-k` и `ngram-map-k4v` держат по 1 MiB hash map на каждый slot и на каждый включенный mode. History vectors растут во время запросов. `ngram-cache` загружает/обновляет file- и history-dependent maps, поэтому Arriero считает его статически неограниченным и возвращает `low` confidence.

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

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/dspark.gguf --spec-type draft-dspark --spec-draft-n-max 7
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/22105
- https://github.com/ggml-org/llama.cpp/pull/25173
