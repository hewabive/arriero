---
schema: 1
engine: sglang
primaryName: "--enable-hierarchical-cache"
title: "--enable-hierarchical-cache"
summary: Главный выключатель prefix-oriented HiCache: GPU (L1) → RAM хоста (L2) → внешнее хранилище (L3). Decode-offload и `host_pool` retraction могут построить host tier без этого флага, но не включают обычное переиспользование вытесненных префиксов.
group: memory
related:
  - --hicache-ratio
  - --hicache-size
  - --hicache-host-memory-fraction
  - --hicache-write-policy
  - --hicache-io-backend
  - --hicache-mem-layout
  - --hicache-storage-backend
  - --disable-radix-cache
  - --page-size
  - --enable-lmcache
  - --enable-unified-memory
  - --dcp-size
  - --disaggregation-decode-retraction-backup
---

# --enable-hierarchical-cache

## Кратко

`--enable-hierarchical-cache` включает HiCache для дерева префиксов: оно начинает отслеживать, где лежит KV каждого узла — в VRAM (L1), в закрепленной памяти хоста (L2) или во внешнем хранилище (L3). Вытесненный из VRAM префикс остается доступен для повторного использования, пока помещается в host-пул. Это главный, но уже не единственный активатор host tier: decode-offload и `--disaggregation-decode-retraction-backup host_pool` также строят HiCache pool для своих задач. Платит за это хост: L2-пул — дополнительная pinned-память, которую надо заложить в бюджет RAM.

## Оригинальная справка

```text
Enable hierarchical cache
```

## Паспорт аргумента

- Флаги: `--enable-hierarchical-cache`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: движок может сбросить флаг обратно в `false` в `_handle_dllm_inference` (при `--dllm-algorithm` и включенном radix cache печатается «Hierarchical cache is disabled because of using diffusion LLM inference»); в остальных конфликтных случаях он не сбрасывается, а вызывает ошибку старта
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.enable_hierarchical_cache`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_hicache`, `_handle_cache_compatibility`) → построение дерева кеша и выделение host-пула при инициализации scheduler'а

## Что меняет в движке

Отдельной реализации HiCache-дерева больше нет: `HiRadixCache` удален из кода, и HiCache для всех моделей строится поверх `UnifiedRadixCache`. В цепочке `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`) обычная модель доходит до последней ветки `create_unified_radix_cache`: создается `UnifiedRadixCache` с компонентом `FULL` (плюс `SWA`/`MAMBA` у гибридных моделей), и при поднятом флаге вызывается `cache.init_hicache(...)`. Тот через `attach_hybrid_pool_to_unified_cache` (`mem_cache/hybrid_cache/hybrid_pool_assembler.py`) выбирает стратегию по типу device-пула (обычный MHA/MLA, SWA, Mamba, DSA, MiniMax sparse, DeepSeek V4) и создает группу host-пулов (`MHATokenToKVPoolHost` / `MLATokenToKVPoolHost` плюс sidecar-пулы) и `HybridCacheController` — наследника `HiCacheController` (`managers/cache_controller.py`).

Затем `tp_worker.register_hicache_layer_transfer_counter(...)` подключает по-слойный счетчик передачи, за счет которого загрузка KV слоя N+1 из хоста перекрывается со счетом слоя N.

Ветки цепочки, стоящие раньше финальной, HiCache не подключают: pure-SWA модель (без full-слоев) получает `PureSWARadixCache`, `--enable-flexkv` — `FlexKVRadixCache`, а явный `--radix-cache-backend` отдает построение зарегистрированной фабрике.

Далее HiCache добавляет три операции поверх обычного дерева префиксов (`sglang/docs/docs/advanced_features/hicache_design.mdx`):

1. **local match** — поиск по дереву `UnifiedRadixCache` (в апстрим-документации оно называется HiRadixTree) сразу по L1 и L2, без копирования данных;
2. **prefetch** — при заданном `--hicache-storage-backend` подтягивание хвоста префикса из L3 в L2 (порог по умолчанию 256 токенов, политика останова — `--hicache-storage-prefetch-policy`);
3. **write-back** — перенос KV из L1 в L2 и L3 по политике `--hicache-write-policy`.

`__post_init__` при поднятом флаге дополнительно выполняет `_handle_hicache`, где нормализуются layout и IO-backend (`_resolve_layout_io_compatibility`, `_resolve_storage_layout_compatibility`) и проверяется совместимость с DCP (`_resolve_hicache_dcp_compatibility`). Эти проверки пропускаются, только если не активны ни обычный HiCache, ни decode-offload, ни PD decode retraction с backend `host_pool` (в том числе автоматически выбранным).

Отдельный эффект: включенный HiCache попадает в список несовместимостей `_disable_tc_piecewise_cudagraph_if_incompatible` («CPU offload / hierarchical cache»), то есть piecewise-захват CUDA graph через torch.compile для такого инстанса выключается.

## Значения и формат

- Флаг без аргумента.
- Размер L2 задается двумя другими аргументами: `--hicache-ratio` (`2.0` для постоянного cache, `1.2` для buffer_only; отдельный host-pool decode backup без HiCache получает `0.2`) либо `--hicache-size` в гигабайтах, который перекрывает ratio. Если не задан ни один, ratio по умолчанию урезается auto-sizing'ом под долю `--hicache-host-memory-fraction` (по умолчанию `0.8`) от свободной RAM после резерва 10 ГиБ.
- L3 подключается только явным `--hicache-storage-backend`; без него HiCache двухуровневый (L1+L2).
- `--page-size` — общая для L1/L2/L3 гранулярность. Для storage-backend'ов практический ориентир из апстрим-документации — `--page-size 64`; при `page_size 1` метаданных и IO-операций на тот же объем кратно больше.

## Когда использовать

- Многотуровые диалоги, агентные цепочки и длинный общий системный промпт: префикс, вытесненный из VRAM, остается в RAM и переиспользуется вместо повторного prefill.
- Модель занимает почти всю VRAM, и на KV-пул остается мало: L2 расширяет эффективную емкость кеша за счет хоста.
- **Не** включайте, если хост уже близок к пределу по RAM: host-пул выделяется закрепленной (pinned) памятью на старте. При явном размере `HostKVCache.__init__` откажет со «Not enough host memory available…», если после резерва 10 ГиБ места нет; при размере по умолчанию auto-sizing урежет L2 до малого, а без свободной памяти сверх резерва старт упадет с `No host memory is left for HiCache after the 10 GiB reserve`.
- **Не** включайте ради одиночных непохожих запросов: без переиспользуемых префиксов HiCache добавляет только накладные расходы на write-back.
- Не сочетайте с моделями/режимами, где вы уже отключили дерево префиксов — это ошибка старта, а не деградация.

## Влияние на производительность и память

- RAM хоста — основной расход. Размер L2 = `hicache_size` ГБ (десятичных, `1e9` байт) либо `device_pool.size * hicache_ratio` токенов; память закрепленная (pinned), выделяется на старте и на каждый rank отдельно.
- VRAM: сам флаг ничего не отнимает, но косвенно повышает утилизацию KV-пула, потому что вытесненные ветви успевают уехать на хост.
- Время старта растет: аллокация и pinning большого host-буфера занимает заметное время, а `destroy()` при завершении явно снимает регистрацию буферов, чтобы не висеть в uninterruptible sleep.
- Throughput/latency: выигрыш пропорционален доле переиспользуемых префиксов. Оборотная сторона — трафик PCIe на write-back и prefetch; политика `write_through_selective` и `write_back` его снижают.
- Piecewise CUDA graph (torch.compile) для инстанса отключается — это может стоить нескольких процентов на decode.

## Взаимодействие с другими аргументами

- `--disable-radix-cache`: взаимоисключающие, `_handle_cache_compatibility` бросает `ValueError`.
- `--hicache-ratio` / `--hicache-size` / layout и I/O-настройки также могут читаться host tier'ом decode-offload или retraction; prefix write/prefetch policies относятся к обычному HiCache.
- `--enable-lmcache`: взаимоисключающие, `handle_cache_compatibility` бросает `ValueError` «--enable-lmcache and --enable-hierarchical-cache are mutually exclusive».
- `--enable-flexkv`: ветка FlexKV в цепочке стоит **раньше** финальной ветки `UnifiedRadixCache`, поэтому строится `FlexKVRadixCache`, и HiCache к нему не подключается (`hicache_attached=False` в строке `Tree cache initialized`). Проверки этой связки при разборе аргументов нет, а scheduler при этом продолжает считать HiCache включенным — не сочетайте флаги.
- `--enable-unified-memory`: совместимы — HiCache поддержан для всех форм unified-пула (несовместимым с unified-пулом остается только `--enable-lmcache`).
- `--enable-int8-mamba-checkpoint`: несовместим, `_handle_int8_mamba_checkpoint` бросает `ValueError` (host-offload путь не понимает int8-чекпойнты).
- `--dcp-size` > 1: разрешено только для MLA-моделей и только L1/L2 — `--hicache-storage-backend`, спекулятивное декодирование, `--enable-lmcache` и `--enable-hisparse` в этой комбинации отвергаются `NotImplementedError`.
- `--disaggregation-decode-enable-offload-kvcache`: включает те же нормализации `_handle_hicache` и требует заданного `--hicache-storage-backend`.
- `--disaggregation-decode-retraction-backup host_pool`: строит зарезервированный HiCache L2 для KV вытесненных decode-запросов даже без этого флага; при незаданном ratio использует `0.2` без HiCache (при `--hicache-size 0` — не меньше одного запроса максимальной длины, двух при `--disaggregation-decode-host-receive-threshold > 0`), либо `2.0` с HiCache.
- `--optimistic-prefill-attempts`: на prefill-узле PD с HiCache работает только в двух конфигурациях — L2 без `--hicache-storage-backend` с политикой `write_back` или `write_through` либо L3 с `--hicache-host-memory-mode buffer_only` и `write_through`; иначе значение молча сбрасывается в 0 с предупреждением.
- `--dllm-algorithm`: при включенном radix cache гасит HiCache с предупреждением.

## Типовые проблемы и диагностика

- Старт падает с «Not enough host memory available. Requesting X GB but only have Y GB free.» — явно заданный L2 не помещается: уменьшите `--hicache-ratio` или задайте меньший `--hicache-size` (либо уберите оба и доверьте размер auto-sizing'у). Порог на rank считается как `(min(MemAvailable, остаток memory cgroup) − 10 ГиБ) / число rank'ов на узле`.
- L2 меньше ожидаемого при не заданном размере — сработал auto-sizing: ищите в логе `HiCache auto-sizing: ratio A -> B; …` и см. `--hicache-host-memory-fraction`.
- Предупреждение «HiCache … host pool (N tokens) is smaller than the device pool (M tokens); L2 cache effectiveness is reduced.» — host-пул меньше device-пула, толку от L2 почти нет: поднимите ratio выше 1.
- Старт падает с «The arguments enable-hierarchical-cache and disable-radix-cache are mutually exclusive…» — конфликт флагов.
- Ветка кеша подтверждается строкой «Tree cache initialized: source=default impl=UnifiedRadixCache … hicache_attached=True …» (`mem_cache/registry.py`); `hicache_attached=False` при поднятом флаге значит, что сработала более ранняя ветка цепочки (pure-SWA, FlexKV, `--radix-cache-backend`). Состав host-стека показывает «Attached hybrid pool stack to UnifiedRadixCache: pools=…», фактический размер L2 — «Allocating kv hierarchical KV host pool: N tokens, X.XX GB host memory.» (`mem_cache/pool_host/base.py`).
- Значения `--hicache-*`, как их принял движок (уже после нормализации layout/IO), видны в дампе `server_args=` при старте.
- В arriero расход L2 надо явно заложить в host-пул memory draw инстанса, иначе планировщик посчитает хост свободнее, чем он есть (`docs/RESOURCE_MANAGEMENT.md`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-size 100 --hicache-write-policy write_through_selective --hicache-io-backend kernel --hicache-mem-layout page_first
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/serving_hook.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_pool_assembler.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/base.py`
- `sglang/python/sglang/srt/mem_cache/hicache_auto_size.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
