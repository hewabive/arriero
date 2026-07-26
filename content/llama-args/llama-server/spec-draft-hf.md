---
schema: 1
primaryName: "--spec-draft-hf"
title: "--spec-draft-hf"
summary: "Задает Hugging Face repo для draft-модели в формате `<user>/<model>[:quant]`. Работает как `--hf-repo`, но заполняет параметры draft-модели и скачивает GGUF перед загрузкой speculative-контекста."
category: "Параметры speculative decoding"
valueType: "string"
valueHint: "<user>/<model>[:quant]"
aliases:
  - "--spec-draft-hf"
  - "-hfd"
  - "-hfrd"
  - "--hf-repo-draft"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_HF_REPO"
related:
  - "--hf-repo"
  - "--hf-file"
  - "--hf-token"
  - "--offline"
  - "--spec-draft-model"
  - "--spec-type"
---

# --spec-draft-hf

## Кратко

`--spec-draft-hf` задает Hugging Face repository для draft-модели. Значение записывается в `common_params.speculative.draft.mparams.hf_repo`, затем общий обработчик моделей скачивает/находит GGUF в HF cache и заполняет локальный путь draft-модели.

Аргумент нужен, когда draft-модель удобнее доставлять из HF, а не указывать локальным `--spec-draft-model`.

## Оригинальная справка llama.cpp

```text
Same as --hf-repo, but for the draft model (default: unused)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-hf`
- Алиасы: `--spec-draft-hf`, `-hfd`, `-hfrd`, `--hf-repo-draft`
- Формат: `<user>/<model>[:quant]`
- Структура llama.cpp: `common_params.speculative.draft.mparams.hf_repo`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_HF_REPO`
- Значение по умолчанию: не используется
- Этап применения: парсинг, download/cache lookup в `common_params_handle_models()`, затем загрузка draft-модели

## Что меняет в llama-server

После парсинга `common_params_handle_models()` вызывает `common_params_handle_model()` для `params.speculative.draft.mparams`. Если задан HF repo, downloader выбирает GGUF по quant tag, использует `--hf-token` для приватных repo и учитывает `--offline`.

После скачивания draft-модель загружается тем же путем, что и локальный `--spec-draft-model`: сервер пишет `loading draft model '...'`, создает отдельный `llama_model` и `llama_context`, а speculative-код проверяет совместимость vocab с target.

## Значения и формат

Формат совпадает с `--hf-repo`: `namespace/repo` или `namespace/repo:quant`. Quant tag регистронезависим в downloader основного HF-механизма. Если нужен конкретный файл внутри repo, в текущем наборе draft-аргументов отдельного `--spec-draft-hf-file` нет; не смешивайте `--spec-draft-hf` и локальный `--spec-draft-model` без проверки фактического результата.

## Когда использовать

Используйте для reproducible-конфигураций, где target и draft поставляются из известных HF GGUF repo, например в preset для FIM/Qwen Coder. Для air-gapped сервера сначала прогрейте HF cache, затем запускайте с `--offline`.

## Влияние на производительность и память

Первый запуск может скачать веса из сети и заметно увеличить время старта. После загрузки влияние такое же, как у `--spec-draft-model`: отдельные веса, KV-cache и compute buffers draft-модели.

Память draft-модели регулируется `--spec-draft-ngl`, `--spec-draft-device`, `--spec-draft-type-k`, `--spec-draft-type-v` и tensor override параметрами.

## Взаимодействие с другими аргументами

`--hf-token` передается downloader и нужен для приватных draft repo. `--offline` запрещает сетевую загрузку и требует, чтобы нужный файл уже был доступен в cache. Для обычной draft-модели явно задайте `--spec-type draft-simple`. Если repo содержит распознаваемый `mtp-`, `dflash-` или `eagle3-` sidecar, llama.cpp может вывести тип из sidecar, когда `--spec-type` оставлен в default `none`.

При `--spec-type draft-mtp` и `--hf-repo` основная модель может автоматически найти MTP-файл рядом с target. Это отдельный путь от `--spec-draft-hf`; если вы явно задаете draft HF repo, он имеет приоритет как заданная draft-модель.

## INI-пресеты и router-режим

В INI используйте `spec-draft-hf = user/repo:quant` или алиас `hf-repo-draft = user/repo:quant`. Router README предупреждает, что HF repo, alias и часть параметров управляются router при загрузке модели; проверяйте итоговые аргументы subprocess в логах llama-manager.

## Типовые проблемы и диагностика

- `failed to download model from Hugging Face`: repo/tag недоступен, нет сети, неверный token или включен `--offline`.
- `failed to load draft model`: скачанный файл не найден или не является подходящим GGUF.
- Ошибка совместимости vocab: выбран не тот draft repo или quant tag указывает на модель другой семьи.

## Примеры

```bash
llama-server --hf-repo ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF --spec-draft-hf ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF --spec-type draft-simple
```

```bash
llama-server --model /models/target.gguf --spec-draft-hf ggml-org/example-draft-GGUF:Q4_K_M --hf-token hf_... --spec-type draft-simple
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
