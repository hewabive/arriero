---
schema: 1
engine: sglang
primaryName: "--enable-hierarchical-cache"
title: "--enable-hierarchical-cache"
summary: Главный выключатель HiCache — многоуровневого KV-кеша GPU (L1) → RAM хоста (L2) → внешнее хранилище (L3). Без него все остальные `--hicache-*` аргументы движок не читает вообще.
group: memory
related:
  - --hicache-ratio
  - --hicache-size
  - --hicache-write-policy
  - --hicache-io-backend
  - --hicache-mem-layout
  - --hicache-storage-backend
  - --disable-radix-cache
  - --page-size
  - --enable-lmcache
  - --enable-unified-memory
  - --dcp-size
---

# --enable-hierarchical-cache

## Кратко

`--enable-hierarchical-cache` включает HiCache: дерево префиксов начинает отслеживать, где лежит KV каждого узла — в VRAM (L1), в закрепленной памяти хоста (L2) или во внешнем хранилище (L3). Вытесненный из VRAM префикс не пропадает, а остается доступен для повторного использования, пока помещается в host-пул. Это единственный флаг, который активирует всю группу `--hicache-*`: без него `--hicache-ratio`, `--hicache-write-policy`, `--hicache-mem-layout` и остальные лежат в `ServerArgs` мертвым грузом. Платит за это хост: L2-пул — это дополнительная pinned-память, которую надо заранее заложить в бюджет RAM.

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
- Где объявлен: `ServerArgs.enable_hierarchical_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_hicache`, `_handle_cache_compatibility`) → построение дерева кеша и выделение host-пула при инициализации scheduler'а

## Что меняет в движке

Флаг читает `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`) и выбирает одну из двух реализаций:

- для обычных MHA/MLA-моделей — `HiRadixCache` (`mem_cache/hiradix_cache.py`), который создает host-пул (`MHATokenToKVPoolHost` / `MLATokenToKVPoolHost`) и `HiCacheController` (`managers/cache_controller.py`);
- для hybrid-SWA, hybrid-SSM и DSA-моделей (DeepSeek V3.2, GLM-5.1) — `UnifiedRadixCache` с последующим `init_hicache(...)`.

В обоих случаях `tp_worker.register_hicache_layer_transfer_counter(...)` подключает по-слойный счетчик передачи, за счет которого загрузка KV слоя N+1 из хоста перекрывается со счетом слоя N.

Далее HiCache добавляет три операции поверх обычного дерева префиксов (`sglang/docs/docs/advanced_features/hicache_design.mdx`):

1. **local match** — поиск по HiRadixTree сразу по L1 и L2, без копирования данных;
2. **prefetch** — при заданном `--hicache-storage-backend` подтягивание хвоста префикса из L3 в L2 (порог по умолчанию 256 токенов, политика останова — `--hicache-storage-prefetch-policy`);
3. **write-back** — перенос KV из L1 в L2 и L3 по политике `--hicache-write-policy`.

`__post_init__` при поднятом флаге дополнительно выполняет `_handle_hicache`, где нормализуются layout и IO-backend (`_resolve_layout_io_compatibility`, `_resolve_storage_layout_compatibility`) и проверяется совместимость с DCP (`_resolve_hicache_dcp_compatibility`). Все эти проверки **пропускаются целиком**, если флаг не задан и не задан `--disaggregation-decode-enable-offload-kvcache`.

Отдельный эффект: включенный HiCache попадает в список несовместимостей `_disable_tc_piecewise_cudagraph_if_incompatible` («CPU offload / hierarchical cache»), то есть piecewise-захват CUDA graph через torch.compile для такого инстанса выключается.

## Значения и формат

- Флаг без аргумента.
- Размер L2 задается двумя другими аргументами: `--hicache-ratio` (кратность относительно device-пула, по умолчанию `2.0`) либо `--hicache-size` в гигабайтах, который перекрывает ratio.
- L3 подключается только явным `--hicache-storage-backend`; без него HiCache двухуровневый (L1+L2).
- `--page-size` — общая для L1/L2/L3 гранулярность. Для storage-backend'ов практический ориентир из апстрим-документации — `--page-size 64`; при `page_size 1` метаданных и IO-операций на тот же объем кратно больше.

## Когда использовать

- Многотуровые диалоги, агентные цепочки и длинный общий системный промпт: префикс, вытесненный из VRAM, остается в RAM и переиспользуется вместо повторного prefill.
- Модель занимает почти всю VRAM, и на KV-пул остается мало: L2 расширяет эффективную емкость кеша за счет хоста.
- **Не** включайте, если хост уже близок к пределу по RAM: host-пул выделяется закрепленной (pinned) памятью на старте, и `HostKVCache.__init__` откажет со «Not enough host memory available…», оставив меньше 10 ГиБ запаса.
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
- `--hicache-ratio` / `--hicache-size` / `--hicache-write-policy` / `--hicache-io-backend` / `--hicache-mem-layout` / `--hicache-storage-backend*` / `--hicache-storage-prefetch-policy`: читаются только при поднятом флаге.
- `--enable-lmcache` и `--enable-flexkv`: в цепочке выбора кеша ветка HiCache стоит **раньше**, поэтому при одновременном включении LMCache и FlexKV молча игнорируются.
- `--enable-unified-memory`: жестко несовместимы, ассерт «--enable-unified-memory is not yet compatible with hierarchical / host-tiered KV cache…».
- `--enable-int8-mamba-checkpoint`: несовместим, `_handle_int8_mamba_checkpoint` бросает `ValueError` (host-offload путь не понимает int8-чекпойнты).
- `--dcp-size` > 1: разрешено только для MLA-моделей и только L1/L2 — `--hicache-storage-backend`, спекулятивное декодирование, `--enable-lmcache` и `--enable-hisparse` в этой комбинации отвергаются `NotImplementedError`.
- `--disaggregation-decode-enable-offload-kvcache`: включает те же нормализации `_handle_hicache` и требует заданного `--hicache-storage-backend`.
- `--optimistic-prefill-attempts`: на prefill-узле PD работает только с L2 и политикой `write_back`; иначе значение молча сбрасывается в 0 с предупреждением.
- `--dllm-algorithm`: при включенном radix cache гасит HiCache с предупреждением.

## Типовые проблемы и диагностика

- Старт падает с «Not enough host memory available. Requesting X GB but only have Y GB free.» — L2 не помещается: уменьшите `--hicache-ratio` или задайте меньший `--hicache-size`. Порог считается как `MemAvailable − 10 ГиБ`.
- Предупреждение «HiCache … host pool (N tokens) is smaller than the device pool (M tokens); L2 cache effectiveness is reduced.» — host-пул меньше device-пула, толку от L2 почти нет: поднимите ratio выше 1.
- Старт падает с «The arguments enable-hierarchical-cache and disable-radix-cache are mutually exclusive…» — конфликт флагов.
- Ветка кеша подтверждается строкой «Tree cache initialized: source=default impl=HiRadixCache … hierarchical=True» (`mem_cache/registry.py`), фактический размер L2 — строкой «Allocating kv hierarchical KV host pool: N tokens, X.XX GB host memory.» (`mem_cache/pool_host/base.py`).
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

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/base.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
