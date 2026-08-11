---
schema: 1
engine: sglang
primaryName: "--enable-lmcache"
title: "--enable-lmcache"
summary: Заменяет обычный RadixCache на `LMCRadixCache` — интеграцию со сторонним пакетом LMCache. Требует установленного `lmcache`, в режиме по умолчанию — еще и `--lmcache-config-file`; молча игнорируется, если включен HiCache или модель гибридная.
group: memory
related:
  - --lmcache-config-file
  - --enable-hierarchical-cache
  - --enable-flexkv
  - --radix-cache-backend
  - --enable-unified-memory
  - --dcp-size
---

# --enable-lmcache

## Кратко

`--enable-lmcache` подключает LMCache как альтернативный (а не дополнительный) механизм многоуровневого KV-кеша: вместо `RadixCache` строится `LMCRadixCache`, который делегирует хранение и подгрузку префиксов внешнему пакету `lmcache`. Это **сторонняя интеграция**: пакета нет в базовой установке SGLang, и его отсутствие проявляется как `RuntimeError` при инициализации кеша, а не при разборе аргументов. Второй подводный камень — позиция флага в цепочке выбора кеша: если включен `--enable-hierarchical-cache` либо модель hybrid-SWA/hybrid-SSM, до ветки LMCache дело не доходит вообще, и флаг оказывается молча проигнорирован.

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
- Эффективное значение: сбрасывается в `false` в `_handle_dllm_inference` при `--dllm-algorithm` и включенном radix cache («LMCache is disabled because of using diffusion LLM inference»); фактически игнорируется, когда цепочка выбора кеша до него не доходит
- Где объявлен: `ServerArgs.enable_lmcache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, реализация целиком во внешнем пакете `lmcache`
- Этап применения: `default_radix_cache_factory` при построении дерева кеша в scheduler'е

## Что меняет в движке

Флаг читается в `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`) и создает `LMCRadixCache` (`mem_cache/storage/lmcache/lmc_radix_cache.py`). Модуль на верхнем уровне делает `from lmcache.integration.sglang…` и при неудаче поднимает `RuntimeError("LMCache is not installed. Please install it by running `pip install lmcache`")`.

`LMCRadixCache` — подкласс обычного `RadixCache`, переопределяющий работу с префиксом; он работает в одном из двух режимов:

- **MP (multi-process)** — режим по умолчанию на CUDA/ROCm. `match_prefix` выполняет только LOOKUP и возвращает `host_hit_length`, а фактический RETRIEVE в уже выделенные GPU-слоты делает `init_load_back` на этапе диспетчеризации. Этот режим **требует** `--lmcache-config-file`: из YAML берутся `mp_host` и `mp_port`, без них конструктор бросает `ValueError("MP mode requires --lmcache-config-file (the YAML supplies mp_host / mp_port).")`.
- **IP (in-process, layerwise)** — выбирается автоматически на XPU (MP-коннектор шарит KV через CUDA IPC, чего на XPU нет). `match_prefix` сразу запускает по-слойную загрузку, а хук `LayerTransferCounter` блокирует каждый слой forward'а до готовности его KV.

Важно, что порядок веток в цепочке фиксирован: ChunkCache при выключенном radix cache → экспериментальное C++-дерево → unified radix tree (по env `SGLANG_ENABLE_UNIFIED_RADIX_TREE` или MLX) → hybrid-SWA → hybrid-SSM → HiCache → **LMCache** → FlexKV → обычный `RadixCache`. Любая сработавшая раньше ветка отменяет LMCache без предупреждения.

Отдельная деталь: цикл планировщика вызывает `tree_cache.check_hicache_events()` при `enable_hierarchical_cache` или `enable_flexkv`; на `--enable-lmcache` этот вызов не завязан.

## Значения и формат

- Флаг без аргумента.
- Все настройки самого LMCache задаются YAML-файлом через `--lmcache-config-file` или собственными переменными окружения пакета.
- Аргумент не «дополняет» HiCache и не складывается с ним: это две взаимоисключающие реализации многоуровневого кеша.

## Когда использовать

- У вас уже развернут LMCache и вы хотите переиспользовать его инфраструктуру вместо встроенного HiCache.
- Вы воспроизводите конфигурацию из документации LMCache и вам нужен именно их формат конфигурации и их пул.
- Во всех остальных случаях встроенный HiCache (`--enable-hierarchical-cache`) предпочтительнее: он не требует внешних пакетов и покрыт апстрим-документацией и тестами SGLang.
- Не включайте вместе с `--enable-hierarchical-cache`: получите HiCache и молчаливое игнорирование LMCache.

## Влияние на производительность и память

- Расход RAM определяется конфигурацией LMCache, а не аргументами SGLang: `--hicache-ratio`/`--hicache-size` к нему отношения не имеют.
- VRAM: сам флаг не выделяет дополнительной памяти на карте; загрузка идет в уже выделенные слоты KV-пула.
- Время старта растет на инициализацию коннектора и, в MP-режиме, на установление соединения с процессом LMCache.
- TTFT на переиспользуемых префиксах падает при попадании; на промахах добавляется стоимость LOOKUP.
- В IP-режиме forward блокируется по-слойно на готовности KV — при медленном хранилище это прямо удлиняет prefill.

## Взаимодействие с другими аргументами

- `--lmcache-config-file`: обязателен в MP-режиме (умолчание на CUDA/ROCm).
- `--enable-hierarchical-cache`: побеждает в цепочке, LMCache игнорируется.
- `--enable-flexkv`: стоит в цепочке **после** LMCache, то есть при одновременном включении выигрывает LMCache.
- `--radix-cache-backend`: любое непустое значение полностью обходит цепочку по умолчанию, включая ветку LMCache.
- `--enable-unified-memory`: жестко несовместим, ассерт «--enable-unified-memory is not yet compatible with hierarchical / host-tiered KV cache (--enable-hierarchical-cache / --enable-lmcache)…».
- `--dcp-size` > 1: `NotImplementedError` «--enable-lmcache with --dcp-size > 1 is not supported: LMCache has no DCP-aware index translation.» — но эта проверка выполняется только при включенном `--enable-hierarchical-cache`.
- `--dllm-algorithm`: гасит флаг с предупреждением.
- Гибридные модели (SWA, Mamba/SSM) и режим unified radix tree: ветка LMCache недостижима.

## Типовые проблемы и диагностика

- `RuntimeError: LMCache is not installed. Please install it by running 'pip install lmcache'` — пакета нет в окружении инстанса.
- `ValueError: MP mode requires --lmcache-config-file (the YAML supplies mp_host / mp_port).` — не задан конфиг для режима по умолчанию.
- Флаг задан, но кеш работает как обычно — проверьте строку «Tree cache initialized: source=… impl=…» (`mem_cache/registry.py`): если `impl` не `LMCRadixCache`, сработала более ранняя ветка цепочки (HiCache, hybrid-модель, unified radix tree, заданный `--radix-cache-backend`).
- Ошибки соединения с процессом LMCache в MP-режиме — проверяйте `mp_host`/`mp_port` в YAML и доступность процесса; SGLang их не валидирует.
- В arriero LMCache — внешняя зависимость окружения: неизменяемое uv-окружение инстанса должно содержать пакет `lmcache` (`docs/ENVIRONMENTS.md`), иначе флаг гарантированно уронит старт.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-lmcache --lmcache-config-file /etc/sglang/lmcache.yaml
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-lmcache --lmcache-config-file /etc/sglang/lmcache.yaml --radix-eviction-policy lru
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/storage/lmcache/lmc_radix_cache.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- arriero: `docs/ENVIRONMENTS.md`
