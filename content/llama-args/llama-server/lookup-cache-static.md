---
schema: 1
primaryName: "--lookup-cache-static"
title: "--lookup-cache-static"
summary: "Указывает бинарный static n-gram lookup cache для speculative decoding типа `ngram-cache`. Файл читается при инициализации speculative context и не должен ожидаться как обновляемый выходной файл."
category: "Параметры llama-server"
valueType: "path"
valueHint: "FNAME"
aliases:
  - "-lcs"
  - "--lookup-cache-static"
allowedValues: []
env: []
related:
  - "--lookup-cache-dynamic"
  - "--spec-type"
  - "--spec-default"
  - "--parallel"
---

# --lookup-cache-static

## Кратко

`--lookup-cache-static FNAME` задает путь к static lookup cache для speculative decoding implementation `ngram-cache`. Один только путь не включает speculative decoding: нужен `--spec-type ngram-cache` или preset, который добавляет этот тип.

Static cache загружается при инициализации speculative context и используется как read-mostly источник n-gram подсказок.

## Оригинальная справка llama.cpp

```text
path to static lookup cache to use for lookup decoding (not updated by generation)
```

## Паспорт аргумента

- Основное имя: `--lookup-cache-static`
- Алиасы: `-lcs`, `--lookup-cache-static`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `path`
- Формат: путь к файлу lookup cache
- Переменные окружения: нет
- Поле в `common_params`: `speculative.ngram_cache.lookup_cache_static`
- Этап применения: парсинг CLI, инициализация speculative decoding

## Что меняет в llama-server

В `common/arg.cpp` путь записывается в `params.speculative.ngram_cache.lookup_cache_static`. В `common/speculative.cpp` implementation `common_speculative_impl_ngram_cache` при создании вызывает `common_ngram_cache_load(path_static)` и копирует загруженный cache в состояние каждой sequence.

Если файл открыть или прочитать не удалось, код логирует `failed to open static lookup cache` и вызывает abort с текстом `Couldn't read static lookup cache`.

## Значения и формат

Путь должен указывать на существующий бинарный файл в формате `common_ngram_cache_save`. Это не JSON и не текстовый словарь. Для управляемых instances используйте абсолютный путь, чтобы не зависеть от рабочего каталога процесса.

## Когда использовать

- Для `--spec-type ngram-cache`, когда есть заранее подготовленный lookup cache.
- Для повторяемых workload, где static corpus помогает предсказывать следующие tokens.
- Когда cache должен быть одинаковым для всех запусков и не изменяться генерацией.

## Влияние на производительность и память

Cache загружается в RAM для speculative state. При `--parallel` состояние создается для нескольких sequences, поэтому большой cache может заметно увеличить RAM. Удачный cache может снизить latency за счет draft tokens; неудачный может дать overhead без выигрыша.

## Взаимодействие с другими аргументами

- Требуется `--spec-type ngram-cache`; иначе путь будет распарсен, но implementation не будет создан.
- `--lookup-cache-dynamic` добавляет второй lookup cache, который проверяется перед static fallback в `common_ngram_cache_draft`.
- `--parallel` влияет на число sequence states, куда копируется cache.
- `--spec-default` в этом commit включает `ngram-mod`, а не `ngram-cache`; не рассчитывайте, что static lookup cache включится через default.

## INI-пресеты и router-режим

```ini
[cached-model]
spec-type = ngram-cache
lookup-cache-static = /var/lib/llama/static.ngram
```

В router mode путь должен быть доступен дочернему процессу модели. Если router запускается как service, учитывайте права пользователя service account.

## Типовые проблемы и диагностика

- Сервер aborts на старте speculative context: проверьте существование файла и права чтения.
- Cache не дает эффекта: убедитесь, что `--spec-type ngram-cache` реально включен; в логах должна быть строка `adding speculative implementation 'ngram-cache'`.
- Неправильный формат файла может привести к assertions при чтении binary records.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-cache --lookup-cache-static /var/lib/llama/static.ngram
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-cache.cpp`
- `llama.cpp/tools/server/README.md`
