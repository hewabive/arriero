---
schema: 1
primaryName: "--models-preset"
title: "--models-preset"
summary: "Подключает INI-файл с модельными пресетами для router-режима. Через него задают кастомные модели, алиасы, теги и параметры дочерних llama-server."
category: "Параметры llama-server"
valueType: "path"
estimation: "router"
valueHint: "PATH"
presetSupport: "router-managed"
aliases:
  - "--models-preset"
allowedValues: []
env:
  - "LLAMA_ARG_MODELS_PRESET"
related:
  - "--models-dir"
  - "--models-max"
  - "--models-autoload"
  - "--alias"
  - "--tags"
  - "--model"
  - "--hf-repo"
---

# --models-preset

## Кратко

`--models-preset` указывает путь к INI-файлу, из которого router строит или дополняет список моделей. Это основной способ задать на одну router-службу несколько моделей с разными `--ctx-size`, `--n-gpu-layers`, `--alias`, `--tags`, draft-моделью и служебными router-only настройками.

## Оригинальная справка llama.cpp

```text
path to INI file containing model presets for the router server (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--models-preset`
- Алиасы: `--models-preset`
- Тип: `PATH`
- Переменная окружения: `LLAMA_ARG_MODELS_PRESET`
- Значение по умолчанию: пустая строка, пользовательский INI не загружается
- Поле `common_params`: `models_preset`
- Этап применения: router загружает INI при построении каталога моделей
- Router-only: да

## Что меняет в llama-server

Router вызывает `common_preset_context::load_from_ini()` и получает набор пресетов. Каждая секция INI становится моделью или переопределением существующей модели. Ключи соответствуют аргументам `llama-server` без ведущих дефисов, коротким формам или env-именам.

Примеры допустимых ключей:

- `model = /models/qwen.gguf` соответствует `--model /models/qwen.gguf`.
- `hf-repo = ggml-org/gemma-3-4b-it-GGUF:Q4_K_M` соответствует `--hf-repo`.
- `c = 8192` соответствует короткому аргументу context size.
- `LLAMA_ARG_CACHE_RAM = 0` использует env-имя аргумента.
- `no-jinja = true` записывает отрицательную форму для bool-аргумента с парным `--no-*`.

## Значения и формат

Файл должен существовать и читаться процессом `llama-server`; иначе старт завершается ошибкой `preset file does not exist` или `failed to open server preset file`.

Синтаксис секций:

```ini
[*]
ctx-size = 8192
n-gpu-layers = 99

[qwen-coder]
model = /srv/models/qwen2.5-coder-7b-q8_0.gguf
alias = coder
tags = code,local
load-on-startup = true

[ggml-org/gemma-3-4b-it-GGUF:Q4_K_M]
alias = gemma
tags = vision,hf
```

Секция `[*]` является глобальной: ее параметры применяются ко всем пресетам, затем модельная секция может их переопределить.

## Когда использовать

Используйте `--models-preset`, когда нужны:

- стабильные API-имена через `--alias`;
- разные параметры загрузки для разных моделей;
- добавление HF-моделей, которых нет в локальном cache;
- настройка `load-on-startup` и `stop-timeout`;
- дополнение моделей, найденных через `--models-dir`.

Для одного простого локального GGUF без router проще использовать `--model`.

## Влияние на производительность и память

Сам INI не загружает веса, кроме моделей с `load-on-startup = true`. Память и время старта зависят от того, сколько таких моделей будет одновременно загружено, и от `--models-max`.

Если `load-on-startup` моделей больше, чем `--models-max`, router завершится ошибкой `number of models to load on startup ... exceeds models_max`.

## Взаимодействие с другими аргументами

Порядок наложения настроек в router:

1. CLI/env аргументы router-процесса имеют высший приоритет и сливаются в каждый модельный пресет.
2. Модельная секция INI.
3. Глобальная секция `[*]`.
4. Автоматические пресеты из cache и `--models-dir`.

Перед запуском дочернего сервера router удаляет из пресета зарезервированные параметры `--models-dir`, `--models-preset`, `--models-max`, `--models-autoload`, TLS/API-key параметры, а также перезаписывает `--host`, `--port` и `--alias`. Поэтому `host`, `port` и API-ключи в модельной секции не являются способом управлять дочерним сервером.

`--alias` и `--tags` читаются из пресета как метаданные router. В JSON `/models` они показываются отдельно, а из отображаемого `status.preset` удаляются.

## INI-пресеты и router-режим

В INI доступны обычные аргументы `llama-server`, а также preset-only ключи:

- `load-on-startup`: boolean, загрузить модель при старте или reload.
- `stop-timeout`: секунды graceful shutdown перед принудительным завершением дочернего процесса, по умолчанию `10`.

Флаги без значения в CLI пишутся как boolean:

```ini
[embeddings]
embd-gemma-default = true
alias = embeddinggemma
```

Для флагов без отрицательной формы значение `false` при рендеринге дочернего argv просто пропускает флаг.

## Типовые проблемы и диагностика

- `option '...' not recognized in preset`: ключ не совпадает с именем аргумента, короткой формой или env-именем.
- Нужный параметр не попал в дочерний процесс: проверьте, не относится ли он к зарезервированным router-аргументам.
- Относительный путь в `model` или `model-draft` не найден: пути считаются от текущего рабочего каталога `llama-server`; используйте абсолютные пути.
- После правки INI модель не изменилась: выполните `GET /models?reload=1`. Running-модель с измененным пресетом будет выгружена и должна быть загружена заново.

## Примеры

```bash
llama-server --models-preset /srv/llama/models.ini --models-max 2
```

```bash
curl "http://127.0.0.1:8080/models?reload=1"
```

```bash
curl -X POST http://127.0.0.1:8080/models/load \
  -H "Content-Type: application/json" \
  -d '{"model":"coder"}'
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--models-preset`, preset-only ключи.
- `llama.cpp/common/preset.cpp`: INI parser, `to_args`, merge/cascade, поддержка env/short keys.
- `llama.cpp/tools/server/server-models.cpp`: приоритеты, reserved args, reload, `/models`.
- `llama.cpp/tools/server/README.md`: разделы `Model presets` и `Routing requests`.
