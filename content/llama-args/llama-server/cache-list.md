---
schema: 1
primaryName: "--cache-list"
title: "--cache-list"
summary: "Печатает список HF-моделей, найденных в cache, и сразу завершает процесс. Используется для диагностики `--hf-repo`/router cache, а не для KV-cache."
category: "Общие параметры"
valueType: "flag"
valueHint: null
aliases:
  - "-cl"
  - "--cache-list"
allowedValues: []
env: []
related:
  - "--hf-repo"
  - "--hf-file"
  - "--offline"
  - "--models-dir"
  - "--models-preset"
---

# --cache-list

## Кратко

`--cache-list` выводит список моделей, найденных в Hugging Face cache llama.cpp, и завершает процесс через `exit(0)`. Это не список KV-cache и не runtime endpoint.

## Оригинальная справка llama.cpp

```text
show list of models in cache
```

## Паспорт аргумента

- Основное имя: `--cache-list`
- Алиасы: `-cl`, `--cache-list`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `flag`
- Переменные окружения: не указаны
- Значение по умолчанию: не выполняется
- Действие: вызывает `common_list_cached_models()`, печатает результат и завершает процесс

## Что меняет в llama-server

При парсинге аргумента обработчик:

```text
auto models = common_list_cached_models();
printf("number of models in cache: %zu\n", models.size());
...
exit(0);
```

То есть server не стартует, порт не открывается, модель не загружается. Команду следует запускать как диагностическую, отдельно от обычного managed instance.

`common_list_cached_models()` перечисляет файлы кэша через `hf_cache::get_cached_files()`, извлекает quant/tag из имени GGUF, пропускает файлы без распознаваемого tag, non-first shard, `mmproj` и `mtp-`, и возвращает уникальные пары `repo:tag`.

Каталог кэша резолвится цепочкой `LLAMA_CACHE` → `HF_HUB_CACHE` → `HUGGINGFACE_HUB_CACHE` → `HF_HOME/hub` → `XDG_CACHE_HOME/huggingface/hub` → `$HOME/.cache/huggingface/hub`; layout HF-hub-совместимый (`models--<owner>--<repo>/snapshots/<commit>`), а не плоский llama.cpp-каталог.

## Значения и формат

Это флаг без значения. Вывод имеет вид:

```text
number of models in cache: 2
   1. owner/repo:Q4_K_M
   2. owner/other:Q8_0
```

Tag в выводе приводится к верхнему регистру, даже если суффикс в имени файла написан строчными буквами.

## Когда использовать

Используйте для проверки, какие HF-модели доступны router-у или offline-запуску. Особенно полезно перед `--offline` и при настройке router, который по умолчанию ищет модели в cache.

Не добавляйте `--cache-list` в постоянную конфигурацию инстанса: процесс завершится после печати списка.

## Влияние на производительность и память

Модель не загружается, RAM/VRAM под inference не выделяются. Стоимость команды - обход cache metadata/files.

## Взаимодействие с другими аргументами

- `--hf-repo`: `--cache-list` помогает увидеть repo:tag, которые уже подготовлены.
- `--offline`: если нужной пары нет в списке, offline HF-запуск вероятно не соберет plan.
- `--models-dir`: не участвует в `--cache-list`; локальные каталоги router показываются другими механизмами.
- `--cache-type-k`, `--cache-type-v`, `--cache-reuse`: не связаны с этим аргументом, потому что они относятся к KV-cache.

## INI-пресеты и router-режим

В INI-пресет добавлять не нужно: это одноразовая diagnostic command. Для router README рекомендует прогревать cache командой:

```bash
llama-server -hf <user>/<model>:<tag>
```

После добавления новой модели сервер нужно перезапустить; README формулирует это как `The server must be restarted after adding a new model`.

## Типовые проблемы и диагностика

- Список пустой: кэш по фактически выбранному пути пуст; проверьте, какая переменная из цепочки `LLAMA_CACHE` → `HF_HUB_CACHE` → `HUGGINGFACE_HUB_CACHE` → `HF_HOME` → `XDG_CACHE_HOME` → `$HOME` действует в окружении процесса.
- Модель есть на диске, но не в списке: это может быть локальный файл вне HF cache (используйте `--models-dir` или `--model`) либо GGUF без распознаваемого quant/tag-суффикса в имени (regex `[-.]([A-Z0-9_]+)$`) — файл вида `model.gguf` дает пустой tag и пропускается целиком.
- `mmproj` не отображается: это ожидаемо, функция исключает projector файлы из списка моделей.
- Split модель отображается один раз: функция пропускает shard index не равный `1`.

## Примеры

```bash
llama-server --cache-list
```

```bash
LLAMA_CACHE=/srv/llama-cache llama-server --cache-list
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/hf-cache.cpp`
- `llama.cpp/common/download.cpp`
- `llama.cpp/common/download.h`
- `llama.cpp/tools/server/README.md`
