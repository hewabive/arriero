---
schema: 1
primaryName: "--fim-qwen-7b-spec"
title: "--fim-qwen-7b-spec"
summary: "Встроенный пресет Qwen2.5-Coder 7B Q8_0 с Qwen2.5-Coder 0.5B draft-моделью для speculative decoding."
category: "Параметры llama-server"
valueType: "flag"
valueHint: null
aliases:
  - "--fim-qwen-7b-spec"
allowedValues: []
env: []
related:
  - "--fim-qwen-7b-default"
  - "--spec-draft-hf"
  - "--spec-draft-model"
  - "--spec-type"
  - "--spec-default"
  - "--hf-repo"
  - "--hf-file"
  - "--cache-reuse"
---

# --fim-qwen-7b-spec

## Кратко

`--fim-qwen-7b-spec` выбирает Qwen2.5-Coder 7B как target-модель и Qwen2.5-Coder 0.5B как draft-модель. Это shortcut для speculative decoding без ручного указания `--spec-draft-hf`.

## Оригинальная справка llama.cpp

```text
use Qwen 2.5 Coder 7B + 0.5B draft for speculative decoding (note: can download weights from the internet)
```

## Паспорт аргумента

- Основное имя: `--fim-qwen-7b-spec`
- Тип: flag без значения
- Env: нет
- Этап применения: парсинг CLI, до загрузки target и draft моделей
- Область: `llama-server`

## Что меняет в llama-server

Флаг записывает:

- `params.model.hf_repo = "ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF"`
- `params.model.hf_file = "qwen2.5-coder-7b-q8_0.gguf"`
- `params.speculative.draft.mparams.hf_repo = "ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF"`
- `params.speculative.draft.mparams.hf_file = "qwen2.5-coder-0.5b-q8_0.gguf"`
- `params.port = 8012`
- `params.n_ubatch = 1024`
- `params.n_batch = 1024`
- `params.n_ctx = 0`
- `params.n_cache_reuse = 256`

Shortcut задаёт путь к обычной draft-модели, но не меняет `params.speculative.types`. Поэтому для фактического speculative decoding добавьте `--spec-type draft-simple`.

## Значения и формат

```bash
llama-server --fim-qwen-7b-spec --spec-type draft-simple
```

INI:

```ini
[coder-7b-spec]
fim-qwen-7b-spec = true
spec-type = draft-simple
alias = coder-spec
tags = code,fim,speculative
```

## Когда использовать

Используйте, когда нужна 7B target-модель и есть смысл ускорить decoding с маленькой draft-моделью. Это полезно для интерактивного code completion, если память позволяет держать обе модели.

Если draft-модель не помещается или acceptance rate низкий на вашем workload, используйте `--fim-qwen-7b-default`.

## Влияние на производительность и память

Speculative decoding добавляет загрузку второй модели. Это увеличивает RAM/VRAM и время старта, но может снизить latency генерации, если draft предсказывает токены, которые target принимает.

Draft offload и CPU-настройки управляются отдельными `--spec-draft-*` аргументами. Этот preset их не задает.

## Взаимодействие с другими аргументами

Связанные speculative аргументы:

- `--spec-type` для явного выбора speculative types.
- `--spec-draft-ngl`, `--spec-draft-device`, `--spec-draft-threads` для ресурсов draft-модели.
- `--spec-draft-n-max`, `--spec-draft-n-min`, `--spec-draft-p-min` для поведения draft decoding.

`--spec-type draft-simple` обязателен для этого shortcut в текущем upstream. `--spec-default` включает другую, ngram-based конфигурацию и не заменяет выбор draft type.

## INI-пресеты и router-режим

В router INI shortcut описывает обе модели:

```ini
[coder-7b-spec]
fim-qwen-7b-spec = true
spec-type = draft-simple
alias = coder
load-on-startup = false
```

Учитывайте `--models-max`: один loaded model instance с draft-моделью считается одной router-моделью, но внутри дочернего процесса занимает память под target и draft.

## Типовые проблемы и диагностика

- Draft-модель скачалась, но в логах нет `adding speculative implementation 'draft-simple'`: добавьте `--spec-type draft-simple`.
- OOM при загрузке: нужны ресурсы для 7B target и 0.5B draft.
- Скорость не выросла: speculative decoding зависит от acceptance rate, backend и draft настройки.
- Скачиваются две модели: target и draft берутся из HF repo.

## Примеры

```bash
llama-server --fim-qwen-7b-spec --spec-type draft-simple --port 8082
```

```bash
llama-server --fim-qwen-7b-spec --spec-type draft-simple --spec-draft-ngl all --ctx-size 32768
```

## Источники

- `llama.cpp/common/arg.cpp`: handler `--fim-qwen-7b-spec`, `--spec-type`, draft args.
- `llama.cpp/common/speculative.cpp`: automatic draft-simple enable и speculative init.
- `llama.cpp/tools/server/server-context.cpp`: загрузка draft context.
- `llama.cpp/tools/server/README.md`: help встроенного пресета.
