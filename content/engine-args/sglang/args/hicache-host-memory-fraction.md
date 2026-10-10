---
schema: 1
engine: sglang
primaryName: "--hicache-host-memory-fraction"
title: "--hicache-host-memory-fraction"
summary: Доля свободной RAM хоста (после резерва 10 ГиБ и с учетом лимитов cgroup), которую HiCache host-пулы всех rank'ов машины могут занять, когда ни `--hicache-ratio`, ни `--hicache-size` не заданы; движок уменьшает ratio по умолчанию, пока пулы не поместятся. Снижайте, если несколько движков делят одну RAM или одну memory cgroup.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-ratio
  - --hicache-size
  - --hicache-host-memory-mode
  - --disaggregation-decode-retraction-backup
  - --mem-fraction-static
  - --tp-size
---

# --hicache-host-memory-fraction

## Кратко

Раньше host-пул HiCache по умолчанию строился как `device_pool × 2.0` и, если RAM не хватало, старт падал с `Not enough host memory available`. Теперь, когда ни `--hicache-ratio`, ни `--hicache-size` не заданы, движок сам урезает ratio так, чтобы пулы всех rank'ов этой машины уложились в долю `--hicache-host-memory-fraction` (по умолчанию `0.8`) от доступной памяти — доступной по `MemAvailable` и по лимитам видимой процессу cgroup, за вычетом резерва 10 ГиБ. Ratio только уменьшается, никогда не растет. Любое явное `--hicache-ratio` или `--hicache-size` выключает auto-sizing целиком. Аргумент новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Fraction of the available host memory, bounded by visible cgroup memory.max/memory.high or v1 memory limits (after a 10 GiB reserve) that the HiCache host pools of all ranks on this machine may use. Applies only when neither --hicache-ratio nor --hicache-size is set: the default ratio is then reduced until the pools fit. Lower it when several engines share a memory cgroup.
```

## Паспорт аргумента

- Флаги: `--hicache-host-memory-fraction`
- Группа: `memory`
- Тип значения: optional float
- Допустимые значения: полуинтервал `(0, 1]`; проверяется в `handle_hicache_ratio_default`, иначе `ValueError: --hicache-host-memory-fraction must be in (0, 1].`
- Значение по умолчанию: `0.8`
- Эффективное значение: `handle_hicache_ratio_default` (`arg_groups/hicache_hook.py`) разрешает его в `None` (auto-sizing выключен), если задан `--hicache-ratio` или `--hicache-size > 0`. Иначе значение сохраняется, а ratio по умолчанию (`2.0` для `cache`, `1.2` для `buffer_only`, на decode — по backend'у retraction) затем уменьшается в `auto_size_hicache` при построении дерева кеша
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.hicache_host_memory_fraction`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_hicache_ratio_default` (проверка, отключение при явном размере) → `build_kv_cache` (`mem_cache/kv_cache_builder.py`), контекст `auto_size_hicache` вокруг `create_tree_cache` — после выделения device KV-пула, до выделения host-пулов

## Что меняет в движке

Auto-sizing (`sglang/python/sglang/srt/mem_cache/hicache_auto_size.py`) включается, когда строится HiCache (`--enable-hierarchical-cache`) или host-pool для decode retraction (`disaggregation_decode_retraction_backup == "host_pool"`), и `hicache_host_memory_fraction` не `None`. Алгоритм:

1. **Доступная память** — `available_host_memory_bytes()` (`mem_cache/host_memory.py`): `psutil.virtual_memory().available`, ограниченный остатком (`limit − usage`) самой тесной cgroup на пути от cgroup процесса до корня. Для cgroup v2 читаются `memory.max` и `memory.high` против `memory.current`, для v1 — `memory.limit_in_bytes` против `memory.usage_in_bytes`; значение `max` игнорируется. Если cgroup-лимит найден, в лог идет `HiCache memory headroom: host X GiB, cgroup Y GiB`.
2. **Бюджет на rank** — `host_memory_budget_bytes()` (`mem_cache/pool_host/base.py`): `(доступная − 10 ГиБ) // ranks_per_host`, где `ranks_per_host` — число rank'ов запуска на один узел (`launch_world_size // nnodes`). Умножается на `--hicache-host-memory-fraction`.
3. **Байты device-пулов** — `_estimate_hicache_bytes`: размер device KV-пула, для которого строятся host-зеркала (для hybrid-SWA — full + SWA, для hybrid-SSM — плюс mamba-пул), плюс пулы draft-модели.
4. **Новый ratio** = `min(ratio_по_умолчанию, бюджет × 0.95 / байты_device)`; 5% — запас на округление до страниц, метаданные аллокатора и staging-буферы.
5. **Синхронизация** — `all_reduce(MIN)` по CPU-группе всего world, так что все rank'и (включая разные PP-стадии) получают одинаковый ratio.
6. Результат записывается поверх `hicache_ratio` (`hicache.auto_size`), а все host-пулы, созданные внутри контекста, бронируют память против одного снимка бюджета, без повторного опроса `psutil`.

В лог идет строка вида `HiCache auto-sizing: ratio 2.000 -> 0.734; 41.3 GiB host memory per rank (fraction 0.80, 2 ranks on this host), host pools 30.1 GiB.` — она печатается всегда, когда auto-sizing работал, даже если ratio не изменился.

Auto-sizing умеет оценивать только пулы `MHATokenToKVPool`, `MLATokenToKVPool` (включая DSA-подкласс), `SWAKVPool`, `HybridLinearKVPool` и `MiniMaxSparseKVPool`. Для остальных (в частности `DeepSeekV4TokenToKVPool`) при незаданном размере старт падает с `HiCache auto-sizing does not support <Pool>; set --hicache-ratio or --hicache-size explicitly.`

## Значения и формат

- Дробное число в `(0, 1]`. `0.8` по умолчанию; `1` — весь остаток после резерва 10 ГиБ.
- Доля считается от **текущей свободной** памяти на момент построения кеша, а не от общего объема RAM: то, что уже заняли другие процессы и сам движок (веса, CPU-копии), в бюджет не входит.
- Бюджет — на всю машину; на rank делится поровну. Задавать «на rank» отдельно нельзя.
- Значения «выключить» у аргумента нет: auto-sizing выключается явным `--hicache-ratio` или `--hicache-size`.
- Если после резерва памяти не осталось вовсе — `ValueError: No host memory is left for HiCache after the 10 GiB reserve; set --hicache-ratio or --hicache-size explicitly.`

## Когда использовать

- Несколько движков на одном хосте или в одной memory cgroup: каждый считает бюджет от того, что свободно в момент его старта, и при `0.8` первый стартовавший забирает большую часть остатка. Задайте каждому долю так, чтобы сумма укладывалась в общий объем.
- Нужен предсказуемый размер L2 — тогда этот аргумент не подходит: размер зависит от того, сколько RAM свободно при старте. Задавайте `--hicache-size` (абсолютный, на rank) или `--hicache-ratio`.
- В arriero host-память инстанса заявляется заранее как memory draw в байтах (`docs/RESOURCE_MANAGEMENT.md`, arriero), а memory-лимиты cgroup инстансам менеджер не выставляет (NUMA-режим ограничивает только cpuset, `docs/NUMA_PINNING.md`, arriero). Auto-sizing там дает размер L2, плавающий от запуска к запуску; для инстансов arriero надежнее явный `--hicache-size`, совпадающий с заявленным draw.

## Влияние на производительность и память

- RAM хоста: потолок для host-пулов HiCache ≈ `fraction × (min(MemAvailable, остаток cgroup) − 10 ГиБ)` на всю машину; память pinned и выделяется на старте.
- VRAM не затрагивается.
- Hit rate L2 падает вместе с урезанным ratio. Если ratio ушел ниже `1.0`, host-пул меньше device-пула, и HiCache предупреждает `L2 cache effectiveness is reduced`.
- Время старта: добавляется один CPU-коллектив `all_reduce` и чтение `/proc/self/cgroup` и `/proc/self/mountinfo`.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: основной потребитель; без HiCache и без host-pool retraction аргумент не читается.
- `--hicache-ratio`: явное значение выключает auto-sizing (`fraction → None`), ratio берется как есть и проверяется только на `Not enough host memory available`.
- `--hicache-size`: любое `> 0` тоже выключает auto-sizing.
- `--hicache-host-memory-mode`: определяет ratio по умолчанию (`2.0` для `cache`, `1.2` для `buffer_only`), от которого auto-sizing отталкивается.
- `--disaggregation-decode-retraction-backup host_pool`: на decode ratio выбирается в `resolve_decode_retraction_backup` (backup-only — от `0.2`, вместе с HiCache — `2.0`) и затем тоже урезается; меньший backup-пул чаще переполняется, а переполнение прерывает вытесненный запрос.
- `--mem-fraction-static`: больший device-пул означает большие `байты_device` и, при том же бюджете, меньший итоговый ratio — суммарный объем L2 в байтах от этого не растет.
- `--tp-size` / `--pp-size`: число rank'ов на узле делит бюджет; для MLA-моделей каждый rank держит полную реплику, так что общий L2 в токенах от TP не растет.
- `--disaggregation-decode-enable-offload-kvcache`: host-пул decode-offload строится позже, при инициализации scheduler'а, вне контекста auto-sizing — в бюджет этого аргумента он не входит и проверяется отдельно по свободной RAM.

## Типовые проблемы и диагностика

- `HiCache auto-sizing does not support DeepSeekV4TokenToKVPool; set --hicache-ratio or --hicache-size explicitly.` — модель с неподдержанным пулом; задайте `--hicache-ratio` (для DeepSeek V4 `--hicache-size` запрещен).
- `No host memory is left for HiCache after the 10 GiB reserve` — свободной памяти меньше 10 ГиБ; освободите RAM или задайте размер явно.
- `RuntimeError: Cannot locate the process memory cgroup in mounted cgroup filesystems` — процесс в cgroup, которую не видно в `mountinfo` (нестандартный контейнер). Явный `--hicache-ratio`/`--hicache-size` не спасает: проверка `Not enough host memory available` читает cgroup тем же кодом, нужна корректная монтировка cgroupfs.
- L2 получился заметно меньше ожидаемого — ищите `HiCache auto-sizing: ratio A -> B` и `HiCache memory headroom: host X GiB, cgroup Y GiB`: обычно бюджет срезал cgroup-лимит контейнера или занятая другими процессами RAM.
- Фактический размер пула — в строке `Allocating … hierarchical KV host pool: N tokens, X.XX GB host memory`.
- Принятое значение (или `None` при явном размере) — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-host-memory-fraction 0.4
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tp-size 2 --page-size 64 --enable-hierarchical-cache --hicache-host-memory-mode buffer_only --hicache-storage-backend file --hicache-host-memory-fraction 0.25
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
- `sglang/python/sglang/srt/mem_cache/hicache_auto_size.py`
- `sglang/python/sglang/srt/mem_cache/host_memory.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/base.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/NUMA_PINNING.md`
