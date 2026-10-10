---
schema: 1
engine: sglang
primaryName: "--enable-lmcache"
title: "--enable-lmcache"
summary: Заменяет дерево префиксов на `LMCacheUnifiedRadixCache` — `UnifiedRadixCache`, который подгружает и сохраняет KV через внешний сервис LMCache. Требует пакета `lmcache` и запущенного процесса LMCache; с HiCache, спекуляцией, DP-attention, DCP и PD-дизагрегацией не совместим и отвергается на старте.
group: memory
related:
  - --lmcache-config-file
  - --enable-hierarchical-cache
  - --enable-flexkv
  - --radix-cache-backend
  - --disable-radix-cache
  - --enable-unified-memory
  - --enable-unified-cache-external-linker
  - --speculative-algorithm
  - --enable-dp-attention
  - --dcp-size
  - --disaggregation-mode
  - --enable-streaming-session
---

# --enable-lmcache

## Кратко

`--enable-lmcache` подключает LMCache как альтернативный (а не дополнительный) механизм многоуровневого KV-кеша: вместо обычного `UnifiedRadixCache` строится его подкласс `LMCacheUnifiedRadixCache`, который через коннектор multiprocess-режима LMCache ищет, подгружает и сохраняет префиксы во внешнем сервисе. Это **сторонняя интеграция**: пакета `lmcache` нет в базовой установке SGLang, а внешнее хранилище держит отдельно запущенный процесс LMCache. Конфликты с другими механизмами кеша (HiCache, external linker) и неподдержанные режимы (спекуляция, DP-attention, DCP, PD, streaming sessions) отвергаются на старте ошибкой, а не молчаливым игнорированием флага.

## Оригинальная справка

```text
Using LMCache as an alternative hierarchical cache solution
```

## Паспорт аргумента

- Флаги: `--enable-lmcache`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: сбрасывается в `false` в `handle_dllm_inference` при `--dllm-algorithm` и включенном radix cache («LMCache is disabled because of using diffusion LLM inference»); игнорируется, если задан `--radix-cache-backend` — тогда цепочка выбора кеша по умолчанию не вызывается
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.enable_lmcache`
- Статус: обычный флаг; транспорт и хранилище — во внешнем пакете `lmcache`
- Этап применения: пайплайн разрешения аргументов (`handle_cache_compatibility` в `arg_groups/kv_cache_hook.py`) → `default_radix_cache_factory` при построении дерева кеша в scheduler'е → prefetch, load-back и сохранение на каждом шаге планировщика

## Что меняет в движке

### Выбор дерева кеша

Флаг читается в `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`). Порядок веток цепочки по умолчанию:

1. `UnifiedRadixCache` при выключенном radix cache и `host_pool` retraction;
2. `ChunkCache` / `SWAChunkCache` / `PureSWAChunkCache` при выключенном radix cache и включенном chunked prefill;
3. **LMCache** → `LMCacheUnifiedRadixCache`;
4. `--enable-unified-cache-external-linker` → `UnifiedRadixCache` с linker'ом;
5. pure-SWA модель → `PureSWARadixCache`;
6. `--enable-flexkv` → `FlexKVRadixCache`;
7. `UnifiedRadixCache` (с HiCache, если он включен).

Ветки 1–2 с LMCache не встретятся (выключенный radix cache для LMCache — ошибка старта), поэтому при поднятом флаге LMCache выбирается всегда, если только не задан `--radix-cache-backend`, который обходит всю цепочку.

`LMCacheUnifiedRadixCache` (`mem_cache/storage/lmcache/lmcache_unified_radix_cache.py`) собирает компоненты дерева под модель: `FULL` (кроме pure-SWA), `SWA` для hybrid-SWA, `MAMBA` для hybrid-SSM — гибридные модели поддержаны. Модуль на верхнем уровне импортирует `lmcache.integration.sglang…`, импорт выполняется лениво внутри ветки 3, поэтому отсутствие пакета проявляется только при построении кеша, обычным `ModuleNotFoundError`.

### Как идут данные

Отдельного «in-process» режима больше нет — только коннектор multiprocess-режима `UnifiedLMCacheMPConnector` к внешнему процессу LMCache:

- **LOOKUP.** Перед постановкой запроса в батч `prefetch_from_storage` отправляет асинхронный поиск по токенам; `check_prefetch_progress` опрашивает его, сводит локальное попадание по rank'ам через `MIN` и сообщает внешний хвост как `host_hit_length`.
- **RETRIEVE.** При допуске запроса `init_load_back` выделяет GPU-слоты и запускает загрузку; результат публикуется в дерево, только когда KV уже на GPU. Если слотов не хватило, запрос идет без внешнего попадания (обычный prefill).
- **STORE.** После `cache_unfinished_req` / `insert_req` новый префикс отправляется в LMCache; узел дерева остается заблокированным, пока сохранение не подтверждено.
- Завершение загрузок и сохранений собирает `check_hicache_events()`, который цикл планировщика вызывает и при `--enable-lmcache` (`managers/scheduler.py`).

`POST /hicache/storage-backend/clear` при LMCache очищает его хранилище через `clear_storage_backend`.

### Проверки на старте

`handle_cache_compatibility` при поднятом флаге отвергает:

- `--enable-hierarchical-cache` — `ValueError` «--enable-lmcache and --enable-hierarchical-cache are mutually exclusive»;
- `--enable-unified-cache-external-linker` — `ValueError` «…are mutually exclusive»;
- `--disable-radix-cache` — `ValueError` «--enable-lmcache requires radix cache to be enabled»;
- любое спекулятивное декодирование, `--enable-dp-attention`, `--dcp-size > 1`, `--enable-streaming-session`, `--disaggregation-mode` кроме `null` — `NotImplementedError`;
- `--hicache-host-memory-mode buffer_only` — `ValueError` «--hicache-host-memory-mode=buffer_only is a HiCache-only mode».

Отдельно: `--enable-unified-memory` — ассерт в `handle_unified_memory_pool`, `--enable-int8-mamba-checkpoint` — `ValueError` в `mamba_hook.py`, SM100 native NVFP4 KV с `trtllm_mha` — `ValueError` в `handle_kv4_compatibility`.

## Значения и формат

- Флаг без аргумента.
- Все настройки самого LMCache задаются YAML-файлом через `--lmcache-config-file` (адрес процесса — `mp_host` / `mp_port`) или собственными переменными окружения пакета. SGLang передает путь в коннектор как есть и сам его не проверяет; что произойдет без файла, решает пакет `lmcache` — в checkout'е SGLang этого кода нет.
- Аргумент не «дополняет» HiCache и не складывается с ним: это две взаимоисключающие реализации многоуровневого кеша.

## Когда использовать

- У вас уже развернут LMCache и вы хотите переиспользовать его хранилище, в том числе между перезапусками SGLang: процесс LMCache живет отдельно.
- Вы воспроизводите конфигурацию из документации LMCache и вам нужен именно их формат конфигурации.
- Во всех остальных случаях встроенный HiCache (`--enable-hierarchical-cache`) предпочтительнее: он не требует внешних пакетов и процессов и покрыт апстрим-документацией и тестами SGLang.
- Не включайте на PD-узлах, со спекуляцией, DP-attention или DCP — старт упадет.

## Влияние на производительность и память

- Расход RAM определяется процессом LMCache и его конфигурацией, а не аргументами SGLang: `--hicache-ratio`/`--hicache-size` к нему отношения не имеют.
- VRAM: сам флаг не выделяет дополнительной памяти на карте; загрузка идет в слоты KV-пула, выделяемые при допуске запроса.
- Время старта растет на инициализацию коннектора и установление соединения с процессом LMCache.
- TTFT на переиспользуемых префиксах падает при попадании; на промахах добавляется асинхронный LOOKUP до постановки в батч.
- Узлы, ожидающие подтверждения сохранения, заблокированы от вытеснения — при медленном LMCache это уменьшает эффективную емкость дерева.

## Взаимодействие с другими аргументами

- `--lmcache-config-file`: путь к YAML с адресом процесса LMCache.
- `--enable-hierarchical-cache`, `--enable-unified-cache-external-linker`: взаимоисключающие, ошибка старта.
- `--enable-flexkv`: стоит в цепочке **после** LMCache, то есть при одновременном включении выигрывает LMCache; проверки этой связки нет.
- `--radix-cache-backend`: любое непустое значение полностью обходит цепочку по умолчанию, включая ветку LMCache.
- `--disable-radix-cache`: LMCache требует radix cache, ошибка старта.
- `--enable-unified-memory`: жестко несовместим, ассерт «--enable-unified-memory is not yet compatible with --enable-lmcache: the LMCache offload path indexes the device buffers with the ids it is handed, and under the unified pool those are VIRTUAL.».
- `--speculative-algorithm`, `--enable-dp-attention`, `--enable-streaming-session`, `--disaggregation-mode`: не поддержаны, `NotImplementedError`.
- `--dcp-size` > 1: `NotImplementedError` «--enable-lmcache with --dcp-size > 1 is not supported: LMCache has no DCP-aware index translation» — проверяется независимо от HiCache.
- `--dllm-algorithm`: гасит флаг с предупреждением.

## Типовые проблемы и диагностика

- `ModuleNotFoundError: No module named 'lmcache'` при построении кеша — пакета нет в окружении инстанса.
- Ошибки старта из списка проверок выше — уберите конфликтующий флаг; текст ошибки называет его прямо.
- Флаг задан, но кеш работает как обычно — проверьте строку «Tree cache initialized: source=… impl=…» (`mem_cache/registry.py`): при `impl=LMCacheUnifiedRadixCache` интеграция активна; другое значение означает, что задан `--radix-cache-backend` или флаг погашен `--dllm-algorithm`.
- Предупреждение «LMCache retrieve failed after admission for request <rid>» — загрузка из LMCache не удалась уже после допуска; запрос продолжается без внешнего попадания.
- Ошибки соединения с процессом LMCache — проверяйте `mp_host`/`mp_port` в YAML и доступность процесса; SGLang их не валидирует.
- В arriero LMCache — внешняя зависимость окружения: неизменяемое uv-окружение инстанса должно содержать пакет `lmcache` (`docs/ENVIRONMENTS.md`), а процесс LMCache arriero не запускает — его нужно поднимать и закладывать в бюджет RAM хоста отдельно.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-lmcache --lmcache-config-file /etc/sglang/lmcache.yaml
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-lmcache --lmcache-config-file /etc/sglang/lmcache.yaml --radix-eviction-policy lru
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/mamba_hook.py`
- `sglang/python/sglang/srt/arg_groups/dllm_hook.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/storage/lmcache/lmcache_unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/storage/lmcache/README.md`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- arriero: `docs/ENVIRONMENTS.md`
