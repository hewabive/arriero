---
schema: 1
primaryName: "--lookup-cache-dynamic"
title: "--lookup-cache-dynamic"
summary: "Указывает dynamic n-gram lookup cache для speculative decoding типа `ngram-cache`. В текущем commit путь читается при инициализации; сохранение обратно в файл в этой ветке реализации не включено."
category: "Параметры llama-server"
valueType: "path"
estimation: "normal"
valueHint: "FNAME"
aliases:
  - "-lcd"
  - "--lookup-cache-dynamic"
allowedValues: []
env: []
related:
  - "--lookup-cache-static"
  - "--spec-type"
  - "--spec-default"
  - "--parallel"
---

# --lookup-cache-dynamic

## Кратко

`--lookup-cache-dynamic FNAME` задает путь к dynamic lookup cache для speculative decoding implementation `ngram-cache`. Как и static cache, он используется только если включен `--spec-type ngram-cache`.

Help говорит, что dynamic cache updated by generation. В проверенном commit source загружает dynamic cache из файла, использует его при drafting, но флаги сохранения `save_dynamic` и `save_static` в `common/speculative.cpp` выставлены в `false`, а рядом в коде отмечено, что отдельные bool-параметры для сохранения еще не вынесены в common params. Поэтому не рассчитывайте, что файл будет автоматически перезаписан после генерации.

## Оригинальная справка llama.cpp

```text
path to dynamic lookup cache to use for lookup decoding (updated by generation)
```

## Паспорт аргумента

- Основное имя: `--lookup-cache-dynamic`
- Алиасы: `-lcd`, `--lookup-cache-dynamic`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `path`
- Формат: путь к файлу lookup cache
- Переменные окружения: нет
- Поле в `common_params`: `speculative.ngram_cache.lookup_cache_dynamic`
- Этап применения: парсинг CLI, инициализация speculative decoding

## Что меняет в llama-server

В `common/arg.cpp` путь записывается в `params.speculative.ngram_cache.lookup_cache_dynamic`. В `common/speculative.cpp` `common_speculative_impl_ngram_cache` загружает файл через `common_ngram_cache_load(path_dynamic)` и копирует cache в состояние каждой sequence.

При ошибке чтения логируется `failed to open dynamic lookup cache`, затем процесс aborts с `Couldn't read dynamic lookup cache`.

## Значения и формат

Путь должен указывать на существующий binary n-gram cache в формате `common_ngram_cache_save`. Используйте абсолютные пути и проверяйте права чтения. В текущем commit source не создает новый файл, если путь отсутствует.

## Когда использовать

- Когда у вас есть отдельный dynamic cache, собранный предыдущими инструментами или запуском другой версии.
- Когда нужно отделить static corpus cache от cache, который концептуально предназначен для обновления.
- Для экспериментов с `ngram-cache` speculative decoding на повторяющихся prompts.

## Влияние на производительность и память

Dynamic cache хранится в RAM внутри speculative state. При большом `--parallel` копирование per-sequence увеличивает память. Drafting проверяет context cache, затем dynamic cache, затем static fallback; плохой cache может добавить lookup overhead без ускорения.

## Взаимодействие с другими аргументами

- Требуется `--spec-type ngram-cache`.
- `--lookup-cache-static` можно использовать вместе с dynamic cache; static cache остается fallback.
- `--parallel` влияет на число sequence states.
- `--spec-default` не включает `ngram-cache` в этом commit.

## INI-пресеты и router-режим

```ini
[cached-model]
spec-type = ngram-cache
lookup-cache-dynamic = /var/lib/llama/dynamic.ngram
```

В router mode файл должен быть виден дочернему процессу. Для service deployments проверьте права и mount namespace.

## Типовые проблемы и диагностика

- Файл не существует: сервер aborts при init speculative context.
- Ожидали, что файл обновится: в этом commit save flags для lookup cache не включены, поэтому проверяйте source перед тем как строить workflow на auto-save.
- Cache не используется: проверьте лог `adding speculative implementation 'ngram-cache'` и значение `speculative.types`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-cache --lookup-cache-dynamic /var/lib/llama/dynamic.ngram
```

```bash
llama-server --model /models/model.gguf --spec-type ngram-cache --lookup-cache-static /var/lib/llama/static.ngram --lookup-cache-dynamic /var/lib/llama/dynamic.ngram
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-cache.cpp`
- `llama.cpp/tools/server/README.md`
