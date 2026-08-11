---
schema: 1
engine: vllm
primaryName: "--kv-offloading-size"
title: "--kv-offloading-size"
summary: Размер буфера выгрузки KV-cache в хостовую RAM, в GiB. Один этот аргумент включает offloading целиком; без него никакой выгрузки нет, а сам буфер расширяет prefix cache, а не активную емкость.
group: CacheConfig
related:
  - --kv-offloading-backend
  - --kv-transfer-config
  - --enable-prefix-caching
  - --tensor-parallel-size
  - --disable-hybrid-kv-cache-manager
  - --cpu-offload-gb
---

# --kv-offloading-size

## Кратко

`--kv-offloading-size` — единственный выключатель выгрузки KV-cache: пока он `None`, offloading не активен ни при каких значениях `--kv-offloading-backend`. Заданное значение (в GiB) конвертируется в байты и передается выбранному connector'у как емкость CPU-тира.

Важно понимать, что именно расширяется. Выгружаются **завершенные блоки prefix cache**, а не состояние активных запросов: буфер увеличивает шанс попасть в кэш по префиксу, но не поднимает число одновременно обслуживаемых последовательностей и не заменяет VRAM.

## Оригинальная справка

```text
Size of the KV cache offloading buffer in GiB. When TP > 1, this is
the total buffer size summed across all TP ranks. By default, this is set
to None, which means no KV offloading is enabled. When set, vLLM will
enable KV cache offloading to CPU using the kv_offloading_backend.
```

## Паспорт аргумента

- Флаги: `--kv-offloading-size`
- Группа argparse: `CacheConfig`
- Тип значения: float, единица измерения — GiB
- Допустимые значения: не ограничены списком; дополнительно принимается литерал `None` (и пустая строка) как «выключено»
- Значение по умолчанию: `None` — offloading выключен
- Эффективное значение: не переопределяется, но может быть обесценено — если prefix caching выключен, native-connector логирует отказ и не включает выгрузку
- Где объявлен: `vllm/config/cache.py:CacheConfig.kv_offloading_size`
- Этап применения: `VllmConfig.__post_init__` → `_post_init_kv_transfer_config()` — до проверки совместимости с hybrid KV cache manager

## Что меняет в движке

`_post_init_kv_transfer_config()` (`vllm/config/vllm.py`) выходит немедленно, если значение `None`. Иначе:

1. при отсутствующем `kv_transfer_config` создается пустой `KVTransferConfig`;
2. для backend `native` в него подставляется connector `OffloadingConnector` (или `SimpleCPUOffloadConnector`, если выставлено `VLLM_USE_SIMPLE_KV_OFFLOAD=1`), а в `kv_connector_extra_config` записывается `cpu_bytes_to_use = kv_offloading_size × 2³⁰`;
3. для backend `lmcache` подставляется `LMCacheMPConnector`, и размер **не передается** — емкостью управляет отдельный процесс LMCache;
4. в обоих случаях выставляется `kv_role = "kv_both"`.

Отсюда следуют два неочевидных последствия. Во-первых, аргумент включает KV-connector, а значит движок начинает считать block hashes даже при выключенном prefix caching. Во-вторых, наличие connector'а участвует в решении про hybrid KV cache manager: если `--disable-hybrid-kv-cache-manager` не задан явно, а выбранный connector не поддерживает HMA, менеджер выключается с предупреждением; при явном `--no-disable-hybrid-kv-cache-manager` в такой конфигурации старт падает.

Трактовка размера различается по connector'ам:

- `SimpleCPUOffloadConnector` считает `cpu_bytes_to_use` общесерверным и делит его на `world_size`, получая емкость на rank (переопределяется ключом `cpu_bytes_to_use_per_rank` в extra-config);
- `CPUOffloadingSpec` (используется `OffloadingConnector`) делит `cpu_bytes_to_use` на выровненный размер чанка и получает число CPU-блоков, где чанк уже включает копии всех rank'ов.

Обе трактовки согласуются со справкой: под TP значение задает суммарный буфер, а не буфер на карту.

## Значения и формат

- Дробное число GiB: `--kv-offloading-size 64` — 64 GiB, `--kv-offloading-size 12.5` — 12.5 GiB.
- `None` или пустая строка — выключить.
- Единица фиксирована: GiB (двоичные), пересчет в байты — умножение на `1 << 30`.
- Верхней границы нет; ее задает реальная хостовая RAM. Буфер пиннится (pinned host memory) — это не обычные страницы, и они не свопятся.

## Когда использовать

- Когда рабочая нагрузка имеет большой пул повторяющихся длинных префиксов, который не помещается в VRAM: агентские сессии, длинные системные промпты, повторные запросы к одному документу.
- Когда хостовой RAM реально в избытке и вы готовы отдать десятки гигабайт под пиннинг.
- Не используйте, чтобы «увеличить контекст» или «поднять concurrency»: активные последовательности живут только в GPU-блоках.
- Не включайте вместе с выключенным prefix caching — механизм просто не заработает.
- Аккуратно на гибридных SSM-моделях: выбранный connector может выключить hybrid KV cache manager, а таким моделям он необходим для старта.

## Влияние на производительность и память

- **RAM хоста.** Резервируется указанный объем в pinned-памяти; на многопроцессной раскладке он делится между rank'ами.
- **VRAM.** Не уменьшается и не увеличивается напрямую. Выгрузка освобождает GPU-блоки быстрее, но общий размер KV-cache определяется профилированием.
- **Prefill.** Попадание в CPU-тир заменяет пересчет префикса на DMA-передачу `cudaMemcpyAsync`, идущую асинхронно с вычислениями.
- **Накладные расходы.** Каждый завершенный блок копируется в хост; при низкой доле повторных префиксов это чистые расходы шины PCIe без выигрыша.
- **Время старта.** Добавляется аллокация и пиннинг буфера.

## Взаимодействие с другими аргументами

- `--kv-offloading-backend`: выбирает реализацию; сам по себе ничего не включает.
- `--enable-prefix-caching`: обязателен по смыслу. При выключенном prefix caching в логе появляется `Detected prefix caching disabled, disabling CPU offload since it requires prefix caching.`
- `--kv-transfer-config`: тот же слой конфигурации. Этот аргумент — короткий путь к нему; при явно заданном `--kv-transfer-config` поля connector'а и `cpu_bytes_to_use` будут перезаписаны.
- `--disable-hybrid-kv-cache-manager`: см. выше — совместимость connector'а с HMA решается автоматически, если флаг не задан.
- `--tensor-parallel-size`: значение суммарное по всем TP-rank'ам.
- `--cpu-offload-gb`: другой механизм — выгрузка **весов** модели в RAM. Аргументы независимы и складываются по потреблению хостовой памяти.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но `Prefix cache hit rate` не изменился и в логе нет упоминаний offloading. **Причина:** prefix caching выключен. **Проверка:** предупреждение `Detected prefix caching disabled, disabling CPU offload since it requires prefix caching.` **Лечение:** добавить `--enable-prefix-caching`.
- **Симптом:** `Hybrid KV cache manager was explicitly enabled but is not supported in this configuration.` **Причина:** явный `--no-disable-hybrid-kv-cache-manager` вместе с connector'ом без поддержки HMA. **Лечение:** убрать явный флаг и дать движку решить.
- **Симптом:** предупреждение `Turning off hybrid kv cache manager because --kv-transfer-config selects a KV connector that does not support it.` на модели со скользящим окном. **Причина:** автоматическое отключение HMA. **Последствие:** снижение производительности; для гибридных SSM-моделей — падение старта.
- **Симптом:** хост уходит в нехватку памяти. **Причина:** буфер пиннится целиком и не свопится. **Лечение:** уменьшить значение.
- **Подтверждение:** строка `SimpleCPUOffloadConnector: role=..., per_rank=X GB, world_size=N, ...` (для simple-режима) и метрики CPU-тира в `/metrics`: `vllm:kv_offload_cpu_cache_usage_perc`, `vllm:kv_offload_cpu_allocation_size`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --kv-offloading-size 32
```

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --kv-offloading-size 64 --kv-offloading-backend native
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/v1/simple_cpu_offload_connector.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/factory.py`
- `vllm/vllm/v1/kv_offload/cpu/spec.py`
- `vllm/vllm/v1/simple_kv_offload/manager.py`
- `vllm/docs/features/kv_offloading_usage.md`
