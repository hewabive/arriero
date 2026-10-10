---
schema: 1
engine: sglang
primaryName: "--hicache-write-policy"
title: "--hicache-write-policy"
summary: Определяет, когда KV уезжает из VRAM в host-пул HiCache: сразу при вставке, после второго попадания или только при вытеснении. Меняет и алгоритм вытеснения из L1.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-storage-backend
  - --hicache-ratio
  - --hicache-size
  - --optimistic-prefill-attempts
  - --disaggregation-mode
---

# --hicache-write-policy

## Кратко

`--hicache-write-policy` решает главный компромисс HiCache: платить трафиком PCIe за то, чтобы префикс гарантированно оказался в L2, или экономить трафик и рисковать потерять его при вытеснении. Побочный эффект, о котором легко забыть: политика выбирает не только момент записи, но и **алгоритм вытеснения из VRAM** — `write_back` использует отдельный путь со стейджингом, все остальные — простой проход по листьям. Аргумент читается только при `--enable-hierarchical-cache`.

## Оригинальная справка

```text
The write policy of hierarchical cache.
```

## Паспорт аргумента

- Флаги: `--hicache-write-policy`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `write_back`, `write_through`, `write_through_selective`
- Значение по умолчанию: `write_through`
- Эффективное значение: из CLI не переопределяется; может быть изменено в рантайме через `PUT /hicache/storage-backend` (поле `hicache_write_policy`), при этом внутренний порог `write_through_threshold` пересчитывается
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.hicache_write_policy`
- Статус: обычный
- Этап применения: создание `HybridCacheController` в `UnifiedRadixCache.init_hicache` при инициализации дерева кеша → каждая вставка узла и каждый проход вытеснения

## Что меняет в движке

Отдельного `HiRadixCache` больше нет — HiCache живет в `UnifiedRadixCache` (`sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`). Значение передается в `HybridCacheController(write_policy=…)` (`mem_cache/hybrid_cache/hybrid_pool_assembler.py`) и параллельно задает в `init_hicache` порог и признак write-back, которые хранит ядро дерева (`tree_core`):

```python
self.write_through_threshold = 1 if get_memory().hicache_write_policy == "write_through" else 2
self.is_write_back = self.cache_controller is not None and self.cache_controller.write_policy == "write_back"
```

Дальше работают два механизма.

**Запись из L1 в L2.** При вставке ядро дерева (`_inc_hit_count_and_check` в `mem_cache/unified_cache/unified_tree_core.py`) увеличивает `node.hit_count` у каждого пройденного узла и у нового листа и, если узел еще не забэкаплен и `hit_count >= write_through_threshold`, порождает действие `BackupKV` — асинхронную DMA-передачу в host-пул. Для `write_back` этот путь отключен целиком: проверка возвращается сразу, не увеличивая счетчик.

- `write_through` — порог 1, то есть запись при первой же вставке;
- `write_through_selective` — порог 2, то есть только после повторного обращения к узлу;
- `write_back` — записи по попаданиям нет вообще.

Инвариант write-through: забэкапленные узлы образуют непрерывный префикс от корня. Если у узла есть еще не забэкапленные предки, `_build_backup_kv_action` включает их в ту же цепочку, и бэкап идет сверху вниз; цепочка останавливается на первом узле, которому не хватило host-места.

**Вытеснение из L1.** `UnifiedRadixCache._evict_components` обходит листья, а `tree_core.evict_device_leaf` ветвится по политике:

- `write_back`: забэкапленные листья просто «понижаются» (device-слоты освобождаются, host-копия остается); для незабэкапленного строится `BackupKV` только на сам лист, бэкап выполняется прямо в момент вытеснения, и лист понижается лишь при успехе. Если host-пул не принял данные, поддерево сбрасывается без бэкапа (`_drop_subtree_no_host`) с предупреждением в лог, а если узел заблокирован — остается в VRAM до освобождения host-места;
- `write_through` / `write_through_selective`: ничего не стейджится на лету, забэкапленные узлы понижаются, незабэкапленные просто удаляются. Для `write_through` такие потери при `--enable-metrics` считаются в метрике `sglang:hicache_dropped_tokens_total` с `reason="write_through_unbacked_eviction"` (сброс поддерева при `write_back` — с `reason="host_pressure"`).

Если подключен L3 (`--hicache-storage-backend`), запись в хранилище идет следом за подтверждением записи в L2: `_finish_write_through_ack` вызывает `write_backup_storage` для каждого фрагмента узла. То есть политика управляет и попаданием данных в L3.

## Значения и формат

- `write_through` (по умолчанию) — «каждое обращение сразу пишется на следующий уровень». Максимальный hit rate, максимальный трафик хост↔GPU.
- `write_through_selective` — бэкапится только то, к чему обратились минимум дважды. Порог захардкожен (2) и через CLI не настраивается.
- `write_back` — данные уезжают на хост только в момент вытеснения из VRAM. Минимальный фоновый трафик, но при нехватке места в L2 часть KV теряется безвозвратно.
- Значение вне списка отвергает argparse.

## Когда использовать

- `write_through` — умолчание и правильный выбор, когда полоса PCIe не является узким местом, а префиксы переиспользуются часто.
- `write_through_selective` — когда write-through заметно съедает полосу (много уникальных запросов, из которых переиспользуется меньшинство): фильтр «второе попадание» отсекает одноразовые ветви.
- `write_back` — когда host-пул мал относительно device-пула и хочется максимально утилизировать L1. Для `--optimistic-prefill-attempts` на prefill-узле PD он больше не обязателен: без L3 подходит и `write_through`.
- Не переключайтесь на `write_back` «для скорости»: он не ускоряет запись, он ее откладывает — и добавляет работу в критический путь вытеснения.

## Влияние на производительность и память

- Трафик PCIe и загрузка DMA: `write_through` > `write_through_selective` > `write_back`.
- Latency вытеснения: у `write_back` вытеснение может блокироваться на стейджинге в хост, у write-through путей — нет.
- Hit rate L2: `write_through` максимален, `write_through_selective` немного ниже на «одноразовых» префиксах, `write_back` ниже всех при дефиците host-пула.
- Объем RAM не зависит от политики — он задан `--hicache-ratio` / `--hicache-size`.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: без него значение не читается.
- `--hicache-ratio` / `--hicache-size`: при `write_back` маленький host-пул напрямую превращается в потерю KV при вытеснении, так что эта пара особенно важна.
- `--hicache-storage-backend`: запись в L3 инициируется после подтверждения записи в L2, то есть политика определяет, что вообще попадет в общее хранилище.
- `--optimistic-prefill-attempts`: при `--disaggregation-mode prefill` и включенном HiCache допустимы только L2 без `--hicache-storage-backend` с политикой `write_back` или `write_through` либо L3 с `--hicache-host-memory-mode buffer_only` и `write_through`; иначе значение молча сбрасывается в 0 с предупреждением «Optimistic prefill supports L2 write-back/write-through or L3 buffer-only write-through hierarchical cache».
- Рантайм-эндпоинт `PUT /hicache/storage-backend` принимает `hicache_write_policy` и меняет политику без перезапуска.

## Типовые проблемы и диагностика

- Предупреждение «write_back: KV subtree dropped without backup due to host memory pressure, root node N» — при `write_back` host-пул не смог принять вытесняемый лист, поддерево потеряно. Увеличьте `--hicache-ratio`/`--hicache-size` или перейдите на write-through. Вариант «… subtree drop declined (node locked); root node N stays device-resident until host space frees» значит, что узел занят и VRAM пока не освобождается.
- «Optimistic prefill supports L2 write-back/write-through or L3 buffer-only write-through hierarchical cache» — оптимистичный prefill отключился из-за политики или из-за сочетания с L3.
- Слишком высокая загрузка PCIe при низком hit rate — типичный признак того, что нужен `write_through_selective`.
- Текущую политику подтверждает дамп `server_args=` при старте; после рантайм-смены — строка «Set hicache_write_policy to …» в логе и ответ `GET /hicache/storage-backend`.
- Эффективность записи видна по счетчикам HiCache при `--enable-metrics` и по доле `cached_tokens` при `--enable-cache-report`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 3 --hicache-write-policy write_through_selective
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-size 80 --hicache-write-policy write_back
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/unified_tree_core.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/storage_attachment.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_pool_assembler.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_storage_runtime_attach_detach.mdx`
