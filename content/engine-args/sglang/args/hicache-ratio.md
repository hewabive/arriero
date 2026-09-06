---
schema: 1
engine: sglang
primaryName: "--hicache-ratio"
title: "--hicache-ratio"
summary: Кратность host-пула относительно device KV-пула в токенах. Автоматически выбирается 2.0 для cache, 1.2 для buffer_only и 0.2 для отдельного host-pool decode backup; положительный hicache-size перекрывает ratio.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-size
  - --mem-fraction-static
  - --page-size
  - --tp-size
  - --disaggregation-decode-enable-offload-kvcache
  - --disaggregation-decode-retraction-backup
---

# --hicache-ratio

## Кратко

Ratio умножает число токенов device pool, а байты рассчитываются по размеру токена конкретной модели/rank. Host memory может быть постоянным L2 (`cache`), staging для storage (`buffer_only`) или резервом decode retraction. Поэтому подходящий ratio зависит от назначения пула.

## Оригинальная справка

```text
The ratio of the size of host KV cache memory pool to the size of device pool. Defaults to 2.0 in cache mode, 1.2 in buffer_only mode, or 0.2 for backup-only host-pool decode retraction.
```

## Паспорт аргумента

- Флаги: `--hicache-ratio`
- Группа: `memory`
- Тип значения: optional float
- Допустимые значения: дробное число; большой постоянный L2 обычно требует ratio больше 1, но для backup-only пула значение меньше 1 является штатным.
- Декларативное значение по умолчанию: `null`
- Эффективное значение: `handle_hicache_ratio_default` в `arg_groups/hicache_hook.py` ставит вне decode `2.0` для cache или `1.2` для buffer_only. На decode `resolve_decode_retraction_backup` выбирает `0.2` только для host_pool без enable_hierarchical_cache, иначе `2.0`. Явный ratio сохраняется; положительный `--hicache-size` перекрывает его.
- Где объявлен: `ServerArgs.hicache_ratio`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор host-пула (`HostKVCache.__init__`) при инициализации дерева кеша, то есть после того, как device-пул уже выделен

## Что меняет в движке

Значение уходит в конструктор `HostKVCache` (`sglang/python/sglang/srt/mem_cache/pool_host/base.py`) как `host_to_device_ratio`. Формула ровно такая:

```python
if host_size > 0:
    self.size = sync_fixed_hicache_size(int(host_size * 1e9 // self.size_per_token), host_size)
else:
    self.size = int(device_pool.size * host_to_device_ratio)
self.page_num = self.size // self.page_size + 1
self.size = self.page_num * self.page_size
```

То есть `--hicache-ratio` используется **только** в ветке `host_size == 0` и работает над числом токенов device-пула. Дальше размер выравнивается вверх на целую страницу (`--page-size`), и по `self.size * self.size_per_token` считается требуемый объем RAM.

Для hybrid-моделей (full + SWA, full + Mamba) тот же ratio передается в каждый под-пул отдельно (`mem_cache/hybrid_cache/hybrid_pool_assembler.py`), то есть суммарный расход RAM — сумма по под-пулам.

Для DeepSeek V4 расчет идет в страницах: `full_host_pages = int(device_full_pages * ratio)` и аналогично для SWA-части; там же `--hicache-size` явно запрещен.

## Значения и формат

- Дробное число; `--hicache-ratio 3` и `--hicache-ratio 3.0` эквивалентны.
- Не задано — `2.0` для постоянного cache, `1.2` для buffer_only, `0.2` для backup-only host_pool на decode. При совместном использовании с HiCache decode-пул получает `2.0`.
- Для постоянного L2 значение ≤ 1 снижает эффективность; host pool может вывести предупреждение «HiCache … host pool (N tokens) is smaller than the device pool (M tokens); L2 cache effectiveness is reduced.» — L2 не сможет удержать даже то, что вытесняется из L1.
- `0` не «отключает» host-пул: это не тот же ноль, что у `--hicache-size`. Ноль в ratio даст `size = 0`, после выравнивания — одну страницу, то есть фактически неработающий L2.
- Верхней границы нет; ограничитель — проверка доступной RAM с резервом 10 ГиБ.

## Когда использовать

- Когда объем host-пула должен масштабироваться вместе с device-пулом: изменили `--mem-fraction-static` или модель — L2 подстроился сам.
- Когда host-пулов несколько (hybrid-модель, несколько rank'ов) и считать точные гигабайты на каждый неудобно.
- Для backup-only decode default `0.2` намеренно меньше device pool: при переполнении backup запрос прерывается, поэтому для более крупных retraction нужен больший ratio.
- Переключитесь на `--hicache-size`, когда важен абсолютный потолок по RAM хоста (типичный случай для arriero: host-пул делится с memory draw других инстансов, `docs/RESOURCE_MANAGEMENT.md`).

## Влияние на производительность и память

- RAM хоста растет линейно: `device_pool.size * ratio * size_per_token` байт на каждый rank, память закрепленная (pinned).
- VRAM не затрагивается.
- Время старта растет с размером буфера — аллокация и `cudaHostRegister` большого pinned-региона не бесплатны.
- Hit rate L2 растет сублинейно; после того как весь горячий набор помещается, дальнейшее увеличение только съедает RAM.
- На throughput в момент вытеснения влияет опосредованно: чем больше L2, тем реже приходится терять префикс совсем.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: основной способ активировать L2 HiCache, но не единственный — decode offload и host-pool retraction тоже строят host pool.
- `--hicache-size`: любой `> 0` полностью перекрывает ratio. Для DeepSeek V4 `--hicache-size` запрещен — там управлять размером можно только через ratio.
- `--mem-fraction-static`, `--max-total-tokens`, `--context-length`: определяют `device_pool.size`, то есть базу, на которую умножается ratio. Увеличили KV-пул на GPU — автоматически выросло и потребление RAM.
- `--page-size`: размер выравнивается вверх до целого числа страниц.
- `--tp-size`: host-пул создается на каждом rank; для MHA-моделей каждый rank хранит свою долю голов, для MLA — реплику. Общий расход RAM хоста считайте по всем rank'ам процесса.
- `--disaggregation-mode decode` + `--disaggregation-decode-enable-offload-kvcache`: асинхронный KV-оффлоад decode-узла строит свой host-пул тем же конструктором и с тем же ratio (`disaggregation/decode_kvcache_offload_manager.py`) — RAM под него считайте по той же формуле.
- `--disaggregation-decode-retraction-backup host_pool`: при незаданном ratio выбирает `0.2` без HiCache либо `2.0` с HiCache; явное значение имеет приоритет.
- `--hicache-host-memory-mode buffer_only`: вне decode выбирает `1.2`, требует storage; это staging, а не постоянный L2.

## Типовые проблемы и диагностика

- «Not enough host memory available. Requesting X GB but only have Y GB free.» — ratio слишком большой для текущей RAM; уменьшите его или уменьшите device-пул. Порог = `MemAvailable − 10 ГиБ`.
- Предупреждение «L2 cache effectiveness is reduced» относится к ёмкости постоянного L2; малый backup-only пул выбран намеренно.
- Фактически выделенный объем печатает сам пул: «Allocating kv hierarchical KV host pool: N tokens, X.XX GB host memory.» — это и есть единственная надежная проверка, во что превратился ваш ratio.
- Значение, как его принял движок, — в дампе `server_args=` при старте.
- Если ожидали изменения, а лог показывает прежний объем, проверьте, не задан ли `--hicache-size`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 4
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --page-size 64 --enable-hierarchical-cache --hicache-ratio 2 --hicache-io-backend direct --hicache-mem-layout page_first_direct
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/base.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_pool_assembler.py`
- `sglang/python/sglang/srt/disaggregation/decode_kvcache_offload_manager.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`

- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
