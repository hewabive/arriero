---
schema: 1
engine: sglang
primaryName: "--enable-flexkv"
title: "--enable-flexkv"
summary: Направляет RadixCache через FlexKV KVManager для оффлоада KV в CPU/SSD/удаленное хранилище. Требует установленного пакета `flexkv`; в цепочке выбора кеша стоит последним, поэтому легко оказывается перекрыт другими флагами.
group: memory
related:
  - --flexkv-config-file
  - --radix-cache-backend
  - --enable-lmcache
  - --enable-hierarchical-cache
  - --dllm-algorithm
---

# --enable-flexkv

## Кратко

`--enable-flexkv` подменяет обычный `RadixCache` на `FlexKVRadixCache`, который отдает хранение префиксов внешнему `KVManager` из пакета FlexKV (CPU-пул, SSD, удаленное хранилище). Это **сторонняя интеграция**: без установленного `flexkv` инициализация кеша падает с `RuntimeError`. Флаг эквивалентен `--radix-cache-backend flexkv` по результату, но отличается механикой: он участвует в цепочке автовыбора (и потому может быть перекрыт HiCache, LMCache или гибридной моделью) и дополнительно пробрасывает `--flexkv-config-file` в переменную окружения, чего явный путь через реестр не делает.

## Оригинальная справка

```text
Route the default RadixCache through FlexKV's KVManager for host-tier (CPU / SSD / Remote) KV cache offload. Equivalent to --radix-cache-backend=flexkv but also participates in the auto-selection chain alongside --enable-lmcache.
```

## Паспорт аргумента

- Флаги: `--enable-flexkv`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: сбрасывается в `false` в `_handle_dllm_inference` при `--dllm-algorithm` и включенном radix cache («FlexKV is disabled because of using diffusion LLM inference»); фактически игнорируется, если цепочка выбора кеша до него не доходит
- Где объявлен: `ServerArgs.enable_flexkv`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, реализация целиком во внешнем пакете `flexkv`
- Этап применения: `default_radix_cache_factory` при построении дерева кеша в scheduler'е

## Что меняет в движке

В `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`) ветка FlexKV — **последняя** перед обычным `RadixCache`:

```python
if server_args.enable_flexkv:
    from sglang.srt.mem_cache.storage.flexkv import _flexkv_factory
    if server_args.flexkv_config_file and not os.environ.get("FLEXKV_CONFIG_PATH"):
        os.environ["FLEXKV_CONFIG_PATH"] = server_args.flexkv_config_file
    return _flexkv_factory(ctx)
```

`_flexkv_factory` собирает `FlexKVRadixCache` с рангами и группами по трем осям (PP × CP × TP) и создает `FlexKVConnector`, который импортирует `flexkv` на уровне модуля; при неудаче — `RuntimeError("FlexKV is not installed. Please install the FlexKV package to use --enable-flexkv.")`.

`FlexKVRadixCache` — подкласс `RadixCache`, переопределяющий `match_prefix`, `init_load_back`, `cache_finished_req`, `evict` и `check_hicache_events`. Два режима:

- **MP (синхронный, по умолчанию)** — `match_prefix` делает только LOOKUP, а RETRIEVE выполняется в `init_load_back` уже в выделенные GPU-слоты;
- **IP (layerwise)** — включается переменной окружения `FLEXKV_ENABLE_LAYERWISE_TRANSFER=1`; каждый слой forward'а блокируется на своем eventfd до готовности KV. Требует доступности UDS-сокета FlexKV-воркера.

Планировщик специально знает про FlexKV: `check_hicache_events()` вызывается при `enable_hierarchical_cache` **или** `get_memory().enable_flexkv` (`managers/scheduler.py`) — именно оттуда дренируются завершенные асинхронные записи.

Порядок цепочки: ChunkCache (при отключенном radix cache) → C++-дерево → unified radix tree → hybrid-SWA → hybrid-SSM → HiCache → LMCache → **FlexKV** → `RadixCache`. Любая сработавшая раньше ветка отменяет FlexKV молча.

## Значения и формат

- Флаг без аргумента.
- Настройки FlexKV задаются YAML/JSON-файлом (`--flexkv-config-file`) или переменной `FLEXKV_CONFIG_PATH`; в самом простом виде достаточно одной строки `cpu_cache_gb: 16`.
- Флаг и `--radix-cache-backend flexkv` дают одинаковый объект кеша, но только этот флаг пробрасывает `--flexkv-config-file` в `FLEXKV_CONFIG_PATH`.

## Когда использовать

- Нужен оффлоад KV на SSD или удаленное хранилище, а инфраструктура уже построена на FlexKV.
- Нужен layerwise-режим передачи, которого у встроенного HiCache в этой форме нет.
- В большинстве случаев для локального инстанса встроенный `--enable-hierarchical-cache` проще: он не требует внешнего пакета, конфигурируется штатными `--hicache-*` и покрыт апстрим-документацией.
- Не включайте одновременно с `--enable-hierarchical-cache` или `--enable-lmcache`: оба перекрывают FlexKV в цепочке.

## Влияние на производительность и память

- RAM/диск: расход определяется конфигурацией FlexKV (`cpu_cache_gb` и родственные ключи), а не аргументами SGLang.
- VRAM: дополнительной памяти на карте не выделяется, загрузка идет в существующие слоты KV-пула.
- Время старта: добавляется инициализация `KVManager`, регистрация GPU-буферов через `KVTPClient` и, в layerwise-режиме, UDS-хендшейк.
- TTFT: выигрыш на попаданиях в CPU/SSD-уровень; в MP-режиме `retrieve_kv` синхронный, то есть prefill ждет загрузку целиком.
- При TP/PP/CP только «лидер» синхронизации общается с `KVManager`, остальные ранги блокируются на broadcast/barrier — узкое место определяется самым медленным рангом.

## Взаимодействие с другими аргументами

- `--flexkv-config-file`: путь к конфигурации; этим флагом (и только им) он превращается в `FLEXKV_CONFIG_PATH`.
- `--radix-cache-backend flexkv`: эквивалент по результату, но без проброса конфига в переменную окружения.
- `--enable-lmcache`: стоит в цепочке раньше и перекрывает FlexKV.
- `--enable-hierarchical-cache`: перекрывает FlexKV.
- `--disable-radix-cache`: при активном chunked prefill ветка `ChunkCache` срабатывает первой, FlexKV не создается.
- `--dllm-algorithm`: гасит флаг с предупреждением.
- Гибридные модели (SWA, Mamba/SSM) и `SGLANG_ENABLE_UNIFIED_RADIX_TREE=1`: ветка FlexKV недостижима.

## Типовые проблемы и диагностика

- `RuntimeError: FlexKV is not installed. Please install the FlexKV package to use --enable-flexkv.` — пакета нет в окружении инстанса.
- Флаг задан, кеш ведет себя как обычный — смотрите строку «Tree cache initialized: source=default impl=…»: `impl` должен быть `FlexKVRadixCache`, иначе сработала более ранняя ветка.
- Зависание на старте в layerwise-режиме — недоступен UDS-сокет FlexKV-воркера (по умолчанию `/tmp/flexkv_layerwise_eventfd.sock`); проверьте, что воркер запущен с теми же dp/pp/instance-настройками.
- Конфиг задан, но FlexKV его «не видит» — убедитесь, что использован именно `--enable-flexkv`, а не `--radix-cache-backend flexkv`: во втором случае `FLEXKV_CONFIG_PATH` не выставляется, и конфигурацию нужно задавать переменной окружения самостоятельно.
- В arriero пакет `flexkv` должен присутствовать в неизменяемом uv-окружении инстанса (`docs/ENVIRONMENTS.md`), а расход CPU-пула FlexKV — быть заложен в host memory draw (`docs/RESOURCE_MANAGEMENT.md`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-flexkv --flexkv-config-file /etc/sglang/flexkv.yaml
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --page-size 64 --enable-flexkv --flexkv-config-file /etc/sglang/flexkv.yaml --mem-fraction-static 0.45
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/__init__.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/flexkv_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/flexkv_connector.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/README.md`
- `sglang/python/sglang/srt/managers/scheduler.py`
- arriero: `docs/ENVIRONMENTS.md`, `docs/RESOURCE_MANAGEMENT.md`
