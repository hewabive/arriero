---
schema: 1
primaryName: "--mmproj"
title: "--mmproj"
summary: "Задает локальный файл multimodal projector для vision/audio-capable моделей. При наличии projector сервер инициализирует `mtmd_context` и включает multimodal обработку запросов."
category: "Параметры llama-server"
valueType: "path"
valueHint: "FILE"
presetSupport: "model-managed"
aliases:
  - "-mm"
  - "--mmproj"
allowedValues: []
env:
  - "LLAMA_ARG_MMPROJ"
related:
  - "--mmproj-url"
  - "--mmproj-auto"
  - "--mmproj-offload"
  - "--image-min-tokens"
  - "--image-max-tokens"
  - "--hf-repo"
  - "--model"
---

# --mmproj

## Кратко

`--mmproj` указывает локальный GGUF-файл multimodal projector. Значение записывается в `common_params.mmproj.path`; при загрузке модели server создает `mtmd_context` через `mtmd_init_from_file(mmproj_path, model_tgt, mparams)`.

Если модель выбрана через `--hf-repo`, projector может быть найден и скачан автоматически. Явный `--mmproj` нужен, когда auto-поиск не подходит, projector лежит локально или нужно закрепить конкретную версию.

## Оригинальная справка llama.cpp

```text
path to a multimodal projector file. see tools/mtmd/README.md
note: if -hf is used, this argument can be omitted
```

## Паспорт аргумента

- Основное имя: `--mmproj`
- Алиасы: `-mm`, `--mmproj`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `path`
- Подсказка формата из `--help`: `FILE`
- Переменные окружения: `LLAMA_ARG_MMPROJ`
- Значение по умолчанию: пусто
- Внутреннее поле: `common_params.mmproj.path`

## Что меняет в llama-server

Если `params_base.mmproj.path` непустой, `server_context::load_model()` готовит `mtmd_context_params`:

- `use_gpu` берется из `--mmproj-offload`;
- `n_threads` берется из CPU params;
- `flash_attn_type`, `warmup`, `image_min_tokens`, `image_max_tokens` передаются в mtmd;
- `media_marker` берется из server helper.

После успешной инициализации появляется лог `loaded multimodal model, '<path>'`. Если `mtmd_init_from_file()` возвращает `nullptr`, сервер логирует `failed to load multimodal model` и старт модели считается неуспешным.

При loaded `mmproj` server отключает несовместимые режимы: `ctx_shift` и `cache_reuse` сбрасываются с warning, потому что multimodal их не поддерживает.

## Значения и формат

Ожидается путь к projector GGUF. Для router `--models-dir` README рекомендует класть multimodal модель в подкаталог рядом с файлом, имя projector должно начинаться с `mmproj`, например `mmproj-F16.gguf`.

`--mmproj` не является URL; для URL используйте `--mmproj-url`.

## Когда использовать

Используйте `--mmproj`, когда сервер должен принимать изображения или audio input через multimodal API и backbone-модель требует отдельный projector. Для text-only сервера этот аргумент не нужен.

Если HF repo содержит правильный projector рядом с моделью, сначала попробуйте `--hf-repo` без явного `--mmproj`; auto-подбор учитывает соседний путь и близость quant bits.

## Влияние на производительность и память

Projector добавляет память и работу на preprocessing multimodal inputs. При включенном `--fit` server отдельно оценивает worst-case memory usage projector и добавляет ее к fit targets.

GPU offload projector управляется `--mmproj-offload`. На системах с ограниченной VRAM выключение offload может помочь загрузиться ценой CPU latency.

## Взаимодействие с другими аргументами

- `--hf-repo`: может автоматически скачать `mmproj`, если он найден.
- `--mmproj-auto`/`--no-mmproj`: включает или запрещает auto projector из HF.
- `--mmproj-url`: удаленный вариант; после скачивания также заполняет `mmproj.path`.
- `--mmproj-offload`: управляет `mparams.use_gpu`.
- `--image-min-tokens` и `--image-max-tokens`: передаются в mtmd для dynamic resolution vision-моделей.
- `--ctx-shift` и `--cache-reuse`: будут отключены при loaded `mmproj`.

## INI-пресеты и router-режим

В INI:

```ini
[gemma_vision_local]
model = /srv/models/gemma/gemma-3-4b-it-Q8_0.gguf
mmproj = /srv/models/gemma/mmproj-F16.gguf
```

В `--models-dir` multimodal модель лучше держать в отдельной директории с основным GGUF и `mmproj*.gguf`, чтобы router корректно связывал файлы.

## Типовые проблемы и диагностика

- `failed to load multimodal model`: projector не подходит к backbone, поврежден или недоступен.
- Клиент получает ошибку, что audio/image input не поддержан: проверьте наличие `loaded multimodal model` в логах.
- Контекстное сдвигание неожиданно отключено: для multimodal это ожидаемо, смотрите warning `ctx_shift is not supported by multimodal`.
- Auto HF скачал не тот projector: задайте явный `--mmproj`.

## Примеры

```bash
llama-server --model /srv/models/gemma/gemma-3-4b-it-Q8_0.gguf --mmproj /srv/models/gemma/mmproj-F16.gguf
```

```bash
llama-server --hf-repo ggml-org/gemma-3-4b-it-GGUF:Q8_0 --mmproj /srv/pinned/mmproj-F16.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
