---
schema: 1
primaryName: "--defrag-thold"
title: "--defrag-thold"
summary: "Deprecated-заглушка для старого порога дефрагментации KV-cache. В текущем коде значение игнорируется, печатается только warning."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "-dt"
  - "--defrag-thold"
allowedValues: []
env:
  - "LLAMA_ARG_DEFRAG_THOLD"
related:
  - "--ctx-size"
  - "--parallel"
  - "--kv-unified"
---

# --defrag-thold

## Кратко

`--defrag-thold` оставлен для совместимости старых команд. В текущем `arg.cpp` handler не записывает значение ни в какие параметры и только печатает warning.

Новые конфигурации не должны использовать этот аргумент.

## Оригинальная справка llama.cpp

```text
KV cache defragmentation threshold (DEPRECATED)
```

## Паспорт аргумента

- Основное имя: `--defrag-thold`
- Алиасы: `-dt`, `--defrag-thold`
- Значение: строка/число принимается CLI, но игнорируется
- Переменная окружения: `LLAMA_ARG_DEFRAG_THOLD`
- Этап применения: только парсинг CLI
- Runtime-эффект: отсутствует

## Что меняет в llama-server

Ничего в поведении KV-cache. Handler вызывает `LOG_WRN("DEPRECATED: --defrag-thold is deprecated and no longer necessary to specify")` и игнорирует переданное значение.

## Значения и формат

Формально `--help` показывает `N`, но значение не используется. Для новых запусков удалите аргумент из argv/INI.

## Когда использовать

Только чтобы временно не ломать старые wrapper scripts, пока вы чистите конфигурацию. Для настройки памяти используйте актуальные параметры: `--ctx-size`, `--parallel`, `--kv-unified`, `--cache-type-k`, `--cache-type-v`.

## Влияние на производительность и память

Отсутствует. Любые изменения производительности после добавления этого аргумента связаны с другими параметрами.

## Взаимодействие с другими аргументами

Нет runtime-взаимодействий. Связанные параметры в frontmatter указаны только как современные замены для диагностики KV-cache.

## INI-пресеты и router-режим

Ключ `defrag-thold = ...` или `LLAMA_ARG_DEFRAG_THOLD` распознается, но также приведет только к deprecated warning в дочернем процессе.

## Типовые проблемы и диагностика

- Если видите warning `DEPRECATED: --defrag-thold is deprecated`, удалите аргумент.
- Не пытайтесь лечить фрагментацию или OOM этим параметром: он больше не подключен к KV-cache.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 32768 --kv-unified
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/tools/server/README.md`
