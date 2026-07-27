---
schema: 1
primaryName: "--spec-draft-model"
title: "--spec-draft-model"
summary: "Задает локальный GGUF-файл draft-модели для draft-model speculative decoding. Модель загружается на старте отдельно от target и должна быть tokenizer/vocab-совместима с основной моделью."
category: "Параметры speculative decoding"
valueType: "path"
valueHint: "FNAME"
aliases:
  - "--spec-draft-model"
  - "-md"
  - "--model-draft"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_MODEL"
related:
  - "--model"
  - "--spec-draft-hf"
  - "--spec-type"
  - "--spec-draft-ngl"
  - "--spec-draft-device"
  - "--spec-draft-type-k"
  - "--spec-draft-type-v"
  - "--models-preset"
---

# --spec-draft-model

## Кратко

`--spec-draft-model` указывает локальный путь к GGUF draft-модели. Значение записывается в `common_params.speculative.draft.mparams.path`; после обработки моделей сервер загружает draft-модель отдельным `llama_model_load_from_file()` и создает для нее отдельный контекст.

Локальный путь сам по себе не выбирает speculative implementation. Для обычной draft-модели укажите `--spec-type draft-simple`; для EAGLE-3, MTP или DFlash выберите соответствующий тип.

## Оригинальная справка llama.cpp

```text
draft model for speculative decoding (default: unused)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-model`
- Алиасы: `--spec-draft-model`, `-md`, `--model-draft`
- Значение: путь к локальному GGUF-файлу
- Структура llama.cpp: `common_params.speculative.draft.mparams.path`
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_MODEL`
- Значение по умолчанию: не используется
- Этап применения: обработка модели перед стартом, загрузка draft-модели после target-модели

## Что меняет в llama-server

Сервер сначала загружает target-модель, затем при наличии draft-модели пишет в лог `loading draft model '...'`, собирает `params_dft` из базовых параметров и draft-override параметров, загружает веса и создает draft-контекст. В `params_dft` переопределяются `model`, `devices`, `n_gpu_layers`, `cache_type_k`, `cache_type_v`, CPU thread settings и tensor buffer overrides для draft.

`draft-simple` проверяет совместимость vocab: тип vocab, BOS/EOS поведение и размер/текст токенов должны совпадать достаточно близко. При несовместимости инициализация speculative-контекста падает с сообщением про несовместимый draft vocab.

## Значения и формат

Указывайте путь к файлу `.gguf`. Относительные пути разрешаются относительно текущего рабочего каталога процесса `llama-server`; для arriero и router-пресетов практичнее абсолютные пути.

В отличие от `--model` вместе с `--hf-repo`, этот аргумент сам по себе не задает `hf_file`. Для Hugging Face draft-модели используйте `--spec-draft-hf`.

## Когда использовать

Используйте отдельную draft-модель, когда у вас есть меньшая модель той же семьи и с тем же tokenizer, например target 7B/14B и draft 0.5B/1.5B. Цель - дешево предсказать несколько следующих токенов и затем подтвердить их target-моделью.

Не используйте случайную маленькую модель другой архитектуры или tokenizer: сервер либо откажется инициализировать speculative decoding, либо acceptance будет настолько низким, что ускорения не будет.

## Влияние на производительность и память

Draft-модель добавляет время загрузки, память под веса, отдельный KV-cache и compute buffers. Размещение draft-весов управляется `--spec-draft-ngl`, `--spec-draft-device`, `--spec-draft-override-tensor`, `--spec-draft-cpu-moe` и `--spec-draft-n-cpu-moe`.

Даже маленькая draft-модель может занимать заметную VRAM при большом `--parallel` и большом контексте. При включенном `--fit` сервер пытается оценить память draft-модели/MTP и резервирует ее в fit target.

## Взаимодействие с другими аргументами

`--spec-type draft-simple` делает использование draft-модели явным. `--spec-draft-n-max`, `--spec-draft-n-min` и `--spec-draft-p-min` управляют длиной и confidence draft-токенов. `--spec-draft-type-k` и `--spec-draft-type-v` влияют на KV-cache draft-контекста.

`--spec-draft-hf` является альтернативным источником draft-модели. Если заданы оба источника, поведение сводится к общему `common_params_model`: локальный путь и HF repo попадут в одну структуру draft-модели, а обработчик HF может интерпретировать путь как файл внутри repo. Для предсказуемости задавайте только один источник.

## INI-пресеты и router-режим

В `--models-preset` используйте `model-draft = /abs/path/draft.gguf`. README прямо показывает `model-draft` в INI и предупреждает, что относительные пути считаются от CWD сервера.

Для router-режима draft-модель должна быть доступна каждому subprocess, который будет грузить соответствующий preset.

## Типовые проблемы и диагностика

- `failed to load draft model`: путь неверный, нет прав, файл не GGUF или не виден subprocess.
- `the target and draft vocabs are not compatible`: draft-модель не подходит к target.
- `n_seq mismatch`: draft-контекст создан с числом последовательностей, несовместимым с `--parallel`.
- Низкий `draft acceptance`: модель формально совместима, но плохо предсказывает target; пробуйте другую draft-модель, меньше `--spec-draft-n-max` или выше `--spec-draft-p-min`.

## Примеры

```bash
llama-server --model /models/qwen-coder-7b.gguf --spec-draft-model /models/qwen-coder-0.5b.gguf --spec-type draft-simple
```

```ini
[coder]
model = /models/qwen-coder-7b.gguf
model-draft = /models/qwen-coder-0.5b.gguf
spec-type = draft-simple
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
