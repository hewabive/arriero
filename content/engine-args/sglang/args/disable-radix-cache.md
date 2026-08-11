---
schema: 1
engine: sglang
primaryName: "--disable-radix-cache"
title: "--disable-radix-cache"
summary: Выключает переиспользование префиксов (RadixAttention) и переводит планировщик на ChunkCache, который держит KV только на время самого запроса. Нужен для режимов, где переиспользование префикса дает неверный результат, и обязателен для HiSparse.
group: memory
related:
  - --enable-hierarchical-cache
  - --radix-eviction-policy
  - --chunked-prefill-size
  - --page-size
  - --enable-hisparse
  - --prefill-only-disable-kv-cache
  - --enable-mis
---

# --disable-radix-cache

## Кратко

`--disable-radix-cache` отключает дерево префиксов: KV, посчитанный для одного запроса, не индексируется и не переиспользуется следующим. Вместо `RadixCache` планировщик получает `ChunkCache` (или его SWA-варианты), который освобождает слоты сразу после завершения запроса. Флаг вспоминают в трех ситуациях: модель, у которой переиспользование префикса математически неверно; отладка «сколько стоит prefill без кеша»; и включение подсистем, которые сами требуют этого флага (`--enable-hisparse`, `--prefill-only-disable-kv-cache`). Движок и сам выставляет его за вас в добром десятке случаев — их надо знать, иначе аргумент выглядит «не сработавшим».

## Оригинальная справка

```text
Disable RadixAttention for prefix caching.
```

## Паспорт аргумента

- Флаги: `--disable-radix-cache`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`), парного `--no-...` нет
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false` — radix cache включен
- Эффективное значение: движок принудительно поднимает флаг в `true` во многих ветках `__post_init__` (см. «Что меняет в движке»); опустить его обратно в `false` из CLI нельзя
- Где объявлен: `ServerArgs.disable_radix_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (несколько `_handle_*` могут выставить его сами) → построение дерева кеша в `mem_cache/kv_cache_builder.py` при старте scheduler'а

## Что меняет в движке

Значение попадает в `CacheInitParams.disable` и в `TreeCacheBuildContext.disable_radix_cache`, а окончательный выбор класса кеша делает `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`):

- флаг поднят **и** chunked prefill активен (`effective_chunked_prefill_size is not None`) → `ChunkCache`, для hybrid-SWA моделей `SWAChunkCache`, при `full_tokens_per_layer == 0` — `PureSWAChunkCache`;
- флаг поднят, но `chunked_prefill_size` подавлен (это происходит только для мультимодальных моделей на Transformers-backend) → строится обычный `RadixCache` с `disable=True`, у которого `match_prefix`/`insert`/`evict` превращены в no-op.

Практический итог один и тот же: совпадение префикса не ищется, `cached_tokens` в ответе всегда 0, слоты KV-пула освобождаются по завершении запроса.

Движок выставляет флаг сам (каждый раз с записью в лог) в следующих ветках `server_args.py`:

- `_handle_model_capability_adjustments`: модель HRM-Text с `prefix_lm` и EmbeddingGemma — двунаправленное внимание по промпту делает переиспользование префикса неверным;
- `_handle_multi_item_scoring`: `--enable-mis` («Radix cache is disabled because --enable-mis is set.»);
- `_handle_attention_backend_compatibility`: Whisper («Radix cache is disabled for Whisper») и attention backend `dual_chunk_flash_attn`;
- `_handle_deterministic_inference`: attention backend вне списка `RADIX_SUPPORTED_DETERMINISTIC_ATTENTION_BACKEND` при детерминированном выводе;
- `mem_cache/kv_cache_builder.py`: мультимодальная модель на Transformers-backend — здесь флаг поднимается уже после `ServerArgs`, поэтому в дампе `server_args=` он останется `False`, а в логе появится «Radix cache is disabled for multimodal models with the Transformers backend».

## Значения и формат

- Флаг без аргумента: указан — кеш выключен, не указан — включен.
- «Полувыключить» кеш нельзя. Если задача — ограничить, что попадает в дерево, есть отдельные ручки: `--radix-eviction-policy` меняет порядок вытеснения, а не факт кеширования.
- Флаг не освобождает VRAM: KV-пул выделяется по `--mem-fraction-static` независимо от него. Отключение кеша меняет только то, что слоты не удерживаются между запросами.

## Когда использовать

- Обязателен для `--enable-hisparse`: `validate_hisparse` (`sglang/python/sglang/srt/arg_groups/hisparse_hook.py`) падает с «Hierarchical sparse attention currently requires --disable-radix-cache.».
- Обязателен для `--prefill-only-disable-kv-cache`: без него старт падает с «--prefill-only-disable-kv-cache requires --disable-radix-cache because the radix cache indexes KV pool slots that no longer hold real data.».
- Полезен при замере «холодного» prefill в бенчмарке: иначе второй прогон того же промпта измеряет кеш, а не модель.
- **Не** используйте его как средство «освободить память» или «убрать нестабильность»: на объем KV-пула он не влияет, а пропускную способность на повторяющихся префиксах роняет в разы.

## Влияние на производительность и память

- VRAM: прямого влияния нет. Размер KV-пула задают `--mem-fraction-static`, `--max-total-tokens` и `--context-length`.
- Throughput: на нагрузке с общими префиксами (системный промпт, многотуровый диалог, агентные цепочки) отключение кеша — главный источник деградации: каждый запрос считает prefill заново.
- Latency: TTFT растет пропорционально длине непереиспользуемого префикса.
- Косвенно снижается давление на память: `ChunkCache` не удерживает завершенные ветви, поэтому свободных слотов под конкурентные запросы больше, а вытеснение не работает вовсе.
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: взаимоисключающие. `_handle_cache_compatibility` бросает `ValueError` «The arguments enable-hierarchical-cache and disable-radix-cache are mutually exclusive…».
- `--enable-hisparse`, `--prefill-only-disable-kv-cache`: оба требуют этот флаг.
- `--enable-mis`: сам его включает и заодно гасит CUDA graph и chunked prefill.
- `--chunked-prefill-size`: определяет, какой именно класс подставит фабрика — `ChunkCache` при активном chunked prefill, `RadixCache(disable=True)` иначе.
- `--radix-eviction-policy`, `--enable-session-radix-cache`: становятся бессмысленными, поскольку дерева нет.
- `--mamba-radix-cache-strategy`: пас `_mamba_radix_cache_overrides` пропускается целиком, если radix cache выключен.
- `--page-size`: ограничение «page_size кратен block_size» в `arg_groups/overrides.py` применяется только при включенном radix cache.

## Типовые проблемы и диагностика

- «Кеш не работает, хотя флаг не задан» — проверьте лог на строки вида «Radix cache is disabled because …»: движок мог поднять флаг сам (MIS, Whisper, детерминированный вывод, dual-chunk backend, мультимодальная модель на Transformers-backend).
- Старт падает с «The arguments enable-hierarchical-cache and disable-radix-cache are mutually exclusive» — уберите один из двух флагов.
- Старт падает с «Hierarchical sparse attention currently requires --disable-radix-cache.» — добавьте флаг на decode-инстанс HiSparse.
- Итоговое состояние подтверждают две строки: дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) и информационная строка фабрики кеша «Tree cache initialized: source=… impl=… hierarchical=…» (`mem_cache/registry.py`) — по `impl=ChunkCache` видно, что дерева нет.
- Метрика переиспользования: `cached_tokens` в ответах при `--enable-cache-report` и счетчики кеша при `--enable-metrics` — при отключенном кеше они не растут.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-radix-cache
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --disable-radix-cache --enable-hisparse --hisparse-config '{"top_k": 2048, "device_buffer_size": 6144, "host_to_device_ratio": 10}' --disaggregation-mode decode
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/chunk_cache.py`
- `sglang/python/sglang/srt/arg_groups/hisparse_hook.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
