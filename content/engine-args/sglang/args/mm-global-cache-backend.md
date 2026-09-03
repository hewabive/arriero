---
schema: 1
engine: sglang
primaryName: "--mm-global-cache-backend"
title: "--mm-global-cache-backend"
summary: Выбирает внешнее хранилище для глобального кеша мультимодальных embeddings. В текущем checkout реализован только `mooncake`, и аргумент читается лишь при включённом `--enable-mm-global-cache`.
group: mm
related:
  - --enable-mm-global-cache
  - --encoder-transfer-backend
  - --encoder-only
  - --tp-size
---

# --mm-global-cache-backend

## Кратко

Флаг отделяет интерфейс глобального embedding cache от его реализации. Кеш хранит уже вычисленные vision/audio embeddings по content hash, чтобы разные encode workers или узлы могли пропустить повторный encoder/ViT forward. Сейчас registry содержит единственный backend — Mooncake.

Без `--enable-mm-global-cache` значение остаётся неактивным: store не создаётся и внешних соединений нет.

## Оригинальная справка

```text
Storage backend for the multimodal global embedding cache. Used when --enable-mm-global-cache is set.
```

## Паспорт аргумента

- Флаги: `--mm-global-cache-backend`
- Группа: `mm`
- Тип значения: строка
- Допустимые значения: `mooncake`
- Значение по умолчанию: `mooncake`
- Где объявлен: `ServerArgs.mm_global_cache_backend`
- Этап применения: инициализация multimodal encode server → `EmbeddingStoreFactory.create_backend` → lookup/prefetch/insert для каждого embedding

## Что меняет в движке

При включённом глобальном кеше `EncodeWorker` вызывает factory с выбранным именем. `mooncake` лениво импортирует `MooncakeEmbeddingStore`, настраивает distributed store и передаёт его `EmbeddingCacheController`. Rank 0 проверяет ключи `emb_<hash>`, prefetch'ит найденные embeddings в локальный pool, а misses вычисляет encoder и асинхронно записывает обратно.

Разделение на `EmbeddingStore` и registry позволяет добавлять реализации без изменения controller, но наличие registry API не расширяет текущий argparse choices: установленная версия принимает только `mooncake`.

## Значения и формат

- `mooncake` — единственное значение; требует рабочей конфигурации Mooncake distributed store и совместимой установленной библиотеки.
- Другое имя отвергается argparse ещё до factory.
- Значение не выбирает `--encoder-transfer-backend`: перенос текущего encoder result и долговременное хранение embeddings — разные механизмы.

## Когда использовать

- Оставляйте default при использовании `--enable-mm-global-cache`: альтернативного штатного backend в checkout нет.
- Не добавляйте флаг в обычный multimodal launch без глобального кеша — он ничего не меняет.
- Глобальный кеш полезен, когда одни и те же media contents повторяются между запросами/узлами и стоимость ViT/encoder выше сетевого lookup.

## Влияние на производительность и память

Cache hit экономит encoder compute и уменьшает latency повторного media item, но добавляет metadata lookup и transfer из Mooncake. `EmbeddingCacheController` использует локальные transfer buffers/pools, поэтому включение кеша требует RAM/registered memory помимо внешнего store. Флаг backend сам по себе ничего не резервирует, пока `--enable-mm-global-cache` выключен.

## Взаимодействие с другими аргументами

- `--enable-mm-global-cache` — обязательный переключатель; только при нём читается backend.
- `--encoder-transfer-backend` передаёт результат текущего encode между ролями и не заменяет global cache store.
- `--tp-size` влияет на число shards/buffers, которыми управляет `EmbeddingCacheController`; mask cache hits синхронизируется между TP-rank'ами.

## Типовые проблемы и диагностика

- `Failed to import embedding store backend 'mooncake'` — в окружении нет требуемого Mooncake-модуля или его зависимостей.
- `Failed to setup Mooncake Embedding Store: <code>` — distributed store не инициализировался; проверьте metadata/master server и transport/device config Mooncake.
- `Unknown embedding store backend ... Registered backends: [...]` возможен для programmatic вызова factory; CLI неизвестное имя обычно остановит argparse раньше.
- Успешный старт подтверждает `Creating embedding store backend 'mooncake'` и `Mooncake Embedding Store initialized successfully.`; hits/inserts видны в `Global Cache: ...` логах controller.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-mm-global-cache --mm-global-cache-backend mooncake
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/mem_cache/embedding_store.py`
- `sglang/python/sglang/srt/mem_cache/embedding_cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/storage/mooncake_store/mooncake_embedding_store.py`
