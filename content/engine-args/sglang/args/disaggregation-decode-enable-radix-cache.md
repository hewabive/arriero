---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-enable-radix-cache"
title: "--disaggregation-decode-enable-radix-cache"
summary: Возвращает decode-серверу radix-кеш вместо принудительного chunk cache. Совпавший префикс decode сообщает prefill'у, и тот не пересылает его по сети. Экспериментально и несовместимо со спекуляцией, HiSparse, SWA/SSM-моделями и backend'ом `fake`.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --enable-hisparse
  - --speculative-algorithm
  - --dcp-size
  - --enable-dp-attention
  - --disaggregation-decode-enable-offload-kvcache
  - --disaggregation-decode-extra-slots
---

# --disaggregation-decode-enable-radix-cache

## Кратко

По умолчанию decode-сервер PD принудительно работает на chunk cache: `handle_pd_disaggregation` ставит `disable_radix_cache = True` и пишет в лог `KV cache is forced as chunk cache for decode server`. Логика в том, что префикс уже посчитан на prefill и приезжает по сети целиком. Этот флаг переворачивает решение: decode держит собственное дерево префиксов, при поступлении запроса матчит по нему, и совпавшую часть **не запрашивает у prefill вовсе** — prefill начинает отправку с `decode_prefix_len`. Флаг помечен в логе как `EXPERIMENTAL` и имеет длинный список несовместимостей.

## Оригинальная справка

```text
Enable radix cache on decode server (PD mode). Caches KV prefixes to avoid redundant transfers. Incompatible with --enable-hisparse, speculative decoding, and --disaggregation-transfer-backend fake.
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-enable-radix-cache`
- Группа: `disagg`
- Тип значения: bool (`action="store_true"`, парного `--no-*` нет)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: само поле не переписывается, но оно **переписывает чужое**: в `handle_pd_disaggregation` при `--disaggregation-mode decode` значение флага задает `disable_radix_cache` — `False` при включенном флаге и `True` при выключенном, независимо от того, что вы указали в `--disable-radix-cache`
- Где объявлен: `ServerArgs.disaggregation_decode_enable_radix_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, но помечен апстримом как экспериментальный (`EXPERIMENTAL: Radix cache is enabled for decode server`)
- Этап применения: разбор CLI → `_handle_pd_disaggregation` (проверки и перезапись `disable_radix_cache`) → построение кеша (`mem_cache/kv_cache_builder.py`, проверки по архитектуре модели) → `pop_preallocated` и учет бюджета в `disaggregation/decode.py` на каждом шаге

## Что меняет в движке

### Матч префикса до передачи

В `DecodePreallocQueue.pop_preallocated` при включенном флаге вызывается `_match_prefix_and_lock`, который дает три величины:

- `prefix_len` — токены, уже лежащие на устройстве (L1-попадание);
- `decode_prefix_len` — полный обещанный prefill'у префикс (L1 + попадание в хостовый пул + попадание в L3-хранилище);
- разрыв между ними добирается загрузкой HiCache позже.

`decode_prefix_len` уходит в PD-протокол; на prefill'е `finalize_bootstrap` читает его (`pop_decode_prefix_len()`), ставит `req.start_send_idx = decode_prefix_len` и отправляет только хвост. Это и есть экономия сетевого трафика, ради которой флаг существует.

### Бюджет и вытеснение

Расчет допустимых токенов на decode начинает учитывать `tree_cache.evictable_size()` — то, что можно освободить, считается доступным. Если перед предвыделением памяти не хватает, вызывается `tree_cache.evict(...)`, и при неудаче в лог идет `Eviction insufficient: needed N tokens, available M`.

### Связка с HiCache

`Scheduler.enable_decode_hicache = disaggregation_decode_enable_radix_cache and enable_hierarchical_cache`. Только при обоих флагах decode на каждой итерации проверяет события HiCache (`check_hicache_events`) и добирает недостающие куски префикса из L2/L3.

### Освобождение слотов

В `process_batch_result_prebuilt` при включенном флаге освобождение KV идет группой (`free_group_begin`) — это нужно, чтобы освобождаемые узлы дерева не разъезжались с конкурентным предвыделением.

## Значения и формат

- Флаг без значения.
- Имеет смысл только при `--disaggregation-mode decode`; на prefill и на монолитном сервере не читается (сам radix там управляется `--disable-radix-cache`).
- Жесткие запреты, проверяемые в `handle_pd_disaggregation`:
  - `--enable-hisparse` → `--disaggregation-decode-enable-radix-cache is incompatible with --enable-hisparse`;
  - `--disaggregation-transfer-backend fake` → `... is incompatible with --disaggregation-transfer-backend fake`;
  - любой `--speculative-algorithm` → `... is incompatible with speculative decoding (--speculative-algorithm ...)`;
  - `--dcp-size > 1` на decode → `PD decode DCP currently requires chunk cache; --disaggregation-decode-enable-radix-cache is not supported.`
- Запреты по архитектуре модели, проверяемые при построении кеша (`mem_cache/kv_cache_builder.py`):
  - гибридный SWA → `... is incompatible with sliding window attention (SWA) models`;
  - Mamba/SSM → `... is incompatible with Mamba/SSM models`.
- С `--enable-dp-attention` запрет не ставится, но печатается предупреждение: без prefix-aware маршрутизации по DP-рангам попаданий будет мало.

## Когда использовать

- Многоходовые диалоги, где decode раз за разом получает один и тот же растущий префикс: экономия здесь двойная — не передается KV и не занимается полоса RDMA.
- Развертывания с `--enable-hierarchical-cache` и L3-хранилищем, где decode может дотянуться до префикса, посчитанного вообще другим сервером.
- Не включайте на однократных независимых запросах: дерево займет память под неиспользуемые узлы, а попаданий не будет.
- Не включайте вместе со спекулятивным декодированием — не заработает, сервер откажется стартовать.
- Не включайте на DP-attention без роутера, который умеет привязывать одинаковые префиксы к одному DP-рангу.

## Влияние на производительность и память

- **VRAM.** Radix-дерево держит страницы KV, которые иначе были бы освобождены сразу. Это не отдельная аллокация, а иное распределение того же пула: свободных токенов под новые запросы становится меньше, но они считаются «вытесняемыми» и учитываются в бюджете.
- **Сеть.** Основной выигрыш: `decode_prefix_len` вырезает совпавший префикс из передачи. На длинных диалогах экономия близка к длине истории.
- **TTFT.** Падает при попадании (нет передачи), слегка растет при промахе (матч и возможная эвикция перед предвыделением).
- **CPU/latency планировщика.** `pop_preallocated` становится дороже: матч по дереву, блокировка узлов, возможная эвикция.
- **Хост.** Сам по себе хостовой памяти не требует; она появляется только вместе с `--enable-hierarchical-cache` и `--disaggregation-decode-enable-offload-kvcache`.

## Взаимодействие с другими аргументами

- `--disable-radix-cache`: на decode-сервере ваш выбор игнорируется — значение задается этим флагом.
- `--enable-hierarchical-cache`: включает L2/L3-путь и `enable_decode_hicache`; без него матч ограничен устройством.
- `--disaggregation-decode-enable-offload-kvcache`: наполняет L3 хвостами, сгенерированными decode'ом; связка «выгрузка + radix» дает попадания на следующих ходах.
- `--enable-hisparse`, `--speculative-algorithm`, `--disaggregation-transfer-backend fake`, `--dcp-size > 1`: взаимоисключающи, отказ на старте.
- `--enable-dp-attention`: работает, но с предупреждением о качестве попаданий.
- `--disaggregation-decode-extra-slots`: слоты под запросы в передаче считаются отдельно от дерева, но делят один пул.

## Типовые проблемы и диагностика

- В логе `KV cache is forced as chunk cache for decode server` — флаг **не** включен, decode работает на chunk cache. Это нормальное умолчание.
- В логе `EXPERIMENTAL: Radix cache is enabled for decode server` — флаг принят.
- `ValueError: --disaggregation-decode-enable-radix-cache is incompatible with speculative decoding (--speculative-algorithm EAGLE)` — уберите один из двух.
- `ValueError: PD decode DCP currently requires chunk cache; --disaggregation-decode-enable-radix-cache is not supported.` — конфликт с `--dcp-size > 1`.
- `ValueError: --disaggregation-decode-enable-radix-cache is incompatible with sliding window attention (SWA) models` / `... with Mamba/SSM models` — ограничение по архитектуре, обходов нет.
- `Eviction insufficient: needed N tokens, available M` — дерево держит слишком много при слишком тесном пуле; уменьшайте `--max-running-requests` или поднимайте `--mem-fraction-static`.
- `EXPERIMENTAL: Decode radix cache with DP attention. Requires prefix-aware DP rank routing for optimal cache hits.` — попадания будут случайными, пока роутер не привязывает префиксы к рангам.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --disaggregation-decode-enable-radix-cache
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --disaggregation-decode-enable-radix-cache --enable-hierarchical-cache --hicache-storage-backend file --disaggregation-decode-enable-offload-kvcache
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/python/sglang/srt/disaggregation/prefill.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/batch_result_processor.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
- `sglang/docs/docs/advanced_features/hicache.mdx`
