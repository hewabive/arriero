---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-retraction-backup"
title: "--disaggregation-decode-retraction-backup"
summary: Выбирает, где decode-сервер PD-развертывания хранит KV вытесненного (retracted) запроса до его возобновления — в разовых CPU-тензорах или в заранее зарезервированном хостовом пуле HiCache. Трогают ради предсказуемого расхода RAM и быстрой реставрации под давлением памяти.
group: disagg
related:
  - --disaggregation-mode
  - --retraction-policy
  - --hicache-ratio
  - --hicache-size
  - --hicache-io-backend
  - --enable-hierarchical-cache
  - --disaggregation-decode-enable-offload-kvcache
  - --disaggregation-decode-enable-radix-cache
  - --dcp-size
  - --enable-priority-scheduling
  - --disable-priority-preemption
  - --num-reserved-decode-tokens
---

# --disaggregation-decode-retraction-backup

## Кратко

В PD-развертывании decode-сервер не умеет пересчитывать префикс сам: когда KV-пул устройства исчерпан, планировщик вытесняет часть работающих запросов (`retract_decode`, порядок жертв задает `--retraction-policy`), но их KV нельзя просто выбросить — его сохраняют на хосте и возвращают на устройство, когда память освободится (`resume_retracted_reqs`). Этот аргумент выбирает механизм хранения: `cpu_tensor` — разовые CPU-тензоры на каждый запрос (историческое поведение), `host_pool` — заранее выделенный pinned-пул HiCache, из которого реставрация идет через L2-движок переносов. Не задан — движок сам выводит backend по типу KV-пула и остальным флагам. Аргумент новый (появился в upstream в августе 2026, PR #34801); проверяйте его наличие в `--help` установленного пакета `sglang-kt`, прежде чем полагаться на него.

## Оригинальная справка

```text
Storage backend for KV preserved across PD decode retraction. 'cpu_tensor' uses per-request CPU tensors. 'host_pool' uses a reserved HiCache pool and does not fall back on exhaustion. If omitted, the backend is inferred from the decode KV pool.
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-retraction-backup`
- Группа: `disagg`
- Тип значения: str
- Допустимые значения: `cpu_tensor`, `host_pool`
- Значение по умолчанию: не задано (`None`)
- Эффективное значение: при `None` разрешается не в `__post_init__`, а после сборки KV-пула — `resolve_decode_retraction_backup` в `mem_cache/kv_cache_builder.py` (вызывается из `Scheduler.init_memory_pools`): `host_pool`, если сервер в режиме `decode`, пул MHA или гибридный SWA с полными слоями, и не включены DCP (`--dcp-size` > 1), radix-кеш decode-стороны, offload-kvcache и приоритетное вытеснение; во всех остальных случаях — `cpu_tensor`
- Где объявлен: `ServerArgs.disaggregation_decode_retraction_backup`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но свежий — в закрепленной паре `sglang-kt` + `kt-kernel` может отсутствовать
- Этап применения: разбор CLI → `_handle_hicache` (нормализация layout/IO выполняется на decode-сервере при `None` или `host_pool` даже без `--enable-hierarchical-cache`) → `_handle_cache_compatibility` (жесткие проверки) → выбор фабрики кеша (`mem_cache/registry.py`) и аллокация хостового пула → разрешение backend'а в `kv_cache_builder` → на каждом вытеснении/возобновлении: `retraction_backup` / `retraction_restore` / `retraction_discard` (`mem_cache/common.py`)

## Что меняет в движке

Точка ветвления — три функции в `mem_cache/common.py`, вызываемые из `release_req` (`managers/schedule_batch.py`), `DecodePreallocQueue.resume_retracted_reqs` и очистки очередей (`disaggregation/decode.py`, abort-путь в `managers/scheduler.py`):

- **`cpu_tensor`** — `Req.offload_kv_cache`: в момент вытеснения `get_cpu_copy` синхронно копирует KV первых `seqlen - 1` токенов (включая Mamba-состояния, если есть) в свежесозданные CPU-тензоры, привязанные к запросу; `load_kv_cache` при возобновлении копирует их обратно и освобождает. Память — обычная (pageable), выделяется по факту, ничего заранее не резервируется.
- **`host_pool`** — `UnifiedRadixCache.retraction_backup`: слоты выделяются в pinned-пуле HiCache (`host_pool_group.alloc`), копирование device→host идет через L2-движок переносов cache controller'а (`--hicache-io-backend`) с постраничным выравниванием и блокирующей синхронизацией (`finish_event.synchronize()`); реставрация — тем же путем host→device. Если слотов не хватило, кеш сперва вытесняет собственные host-записи (`_reclaim_retraction_host`), а если и после этого пусто — **бросает `RuntimeError`, отката в `cpu_tensor` нет** (в этом смысл фразы «does not fall back on exhaustion» из справки).

Выбор `host_pool` (явный или выведенный) меняет и конструкцию кеша: фабрика (`mem_cache/registry.py`) строит `UnifiedRadixCache` и инициализирует HiCache даже без `--enable-hierarchical-cache` и даже при `--disable-radix-cache` — pinned-пул хоста существует ради самой реставрации. После сборки пула `validate_retraction_host_capacity` (`mem_cache/unified_radix_cache.py`) требует, чтобы хостовый пул был не меньше пула устройства (иначе гарантия «любой вытесненный набор поместится» не выполняется) — отсюда и особый default `--hicache-ratio`.

## Значения и формат

- `cpu_tensor` — работает с любым пулом, реализующим `get_cpu_copy` (MHA, MLA, гибриды с Mamba-состояниями). Ограничений совместимости в `_handle_cache_compatibility` нет.
- `host_pool` — жесткие условия, нарушение любого валит старт `ValueError`:
  - только `--disaggregation-mode decode`;
  - несовместим с `--dcp-size` > 1;
  - при `--enable-priority-scheduling` требует `--disable-priority-preemption`;
  - взаимоисключен с `--disaggregation-decode-enable-offload-kvcache` (оба строят decode-пул хоста);
  - тип пула — MHA или гибридный SWA с полными слоями: Mamba-модели и pure-SWA отклоняются фабрикой кеша, MLA-пулы (DeepSeek) не проходят `supports_retraction_backup` — для них при `None` выводится `cpu_tensor`, а явный `host_pool` падает с `requires an MHA or hybrid-SWA HiCache host stack`.
- Не задано (`None`) — «подберет движок»: `host_pool` берется только когда выполняются все условия выше и не включен radix-кеш decode-стороны, иначе `cpu_tensor`. На prefill- и монолитных серверах значение фактически инертно: `retraction_backup` вызывается только при `disaggregation_mode == "decode"`.

## Когда использовать

- `host_pool` (или просто не задавать на подходящей конфигурации): decode-сервер с MHA-пулом под нагрузкой, где вытеснения регулярны — расход RAM фиксируется при старте, копии идут через pinned-память и IO-backend HiCache, нет спонтанных крупных аллокаций в самый неподходящий момент.
- Явный `cpu_tensor`: когда RAM на хосте мало и резервировать пул размером с KV-пул устройства (default `--hicache-ratio` = 1.0) не хочется, а вытеснения редки; либо когда конфигурация в принципе не проходит условия `host_pool` (MLA, Mamba, DCP, приоритетное вытеснение).
- Трогать аргумент на prefill-сервере или монолите смысла нет; `host_pool` там просто не стартует.

## Влияние на производительность и память

- **RAM хоста.** `host_pool`: pinned-пул выделяется один раз на старте, размер — `--hicache-ratio` × пул устройства (при неуказанном ratio на decode-сервере он разрешается в 1.0 для `host_pool` и 2.0 для `cpu_tensor` — `kv_cache_builder.py`; в `__post_init__` `_handle_hicache_ratio_default` ставит 2.0 только вне режима `decode`, оставляя decode-серверу позднее разрешение) либо абсолютный `--hicache-size`. `cpu_tensor`: ноль резерва, но пиковый расход не ограничен — растет с числом и длиной одновременно вытесненных запросов.
- **VRAM.** Не меняется: оба backend'а хранят копию на хосте, устройство освобождается одинаково.
- **Latency вытеснения/возобновления.** Оба пути блокирующие внутри шага планировщика. `host_pool` копирует в заранее выделенную pinned-память через L2-движок переносов; `cpu_tensor` на каждом вытеснении аллоцирует свежие pageable-тензоры и копирует в них — на длинных контекстах это заметнее.
- **Надежность.** `host_pool` дает детерминированную емкость (валидация «host ≥ device» на старте), но при исчерпании — `RuntimeError` без отката. `cpu_tensor` не имеет собственного лимита и при нехватке RAM упирается в OOM-киллер хоста.

## Взаимодействие с другими аргументами

- `--disaggregation-mode`: `host_pool` требует `decode`; сам механизм backup'а работает только на decode-сервере.
- `--retraction-policy`: выбирает, **кого** вытеснять; этот аргумент — **куда** класть KV вытесненного.
- `--hicache-ratio` / `--hicache-size`: задают размер хостового пула для `host_pool`. Неуказанный ratio на decode-сервере становится 1.0 под `host_pool` (иначе 2.0); ratio < 1.0 не пройдет `validate_retraction_host_capacity` («Increase --hicache-ratio or --hicache-size»).
- `--hicache-io-backend`: путь копирования device↔host для `host_pool`.
- `--enable-hierarchical-cache`: не требуется — `host_pool` сам поднимает HiCache-стек; вместе они делят один хостовый пул (реставрация вытесняет кеш-записи при нехватке слотов).
- `--disaggregation-decode-enable-offload-kvcache`: взаимоисключен с `host_pool` (старт падает: «both build a decode host pool»).
- `--disaggregation-decode-enable-radix-cache`: не запрещен вместе с явным `host_pool`, но при `None` его включение сдвигает вывод в `cpu_tensor`.
- `--dcp-size` > 1: несовместим с `host_pool` (ValueError на старте).
- `--enable-priority-scheduling` без `--disable-priority-preemption`: несовместимо с `host_pool`; при `None` такая связка тоже выводит `cpu_tensor`.
- `--disable-radix-cache`: с `host_pool` все равно строится `UnifiedRadixCache` — флаг отключает кеширование префиксов, но не хостовый пул.
- `--num-reserved-decode-tokens`: чем меньше резерв на запрос, тем чаще decode доходит до вытеснения — то есть до этого механизма.

## Типовые проблемы и диагностика

- `ValueError: --disaggregation-decode-retraction-backup=host_pool is only supported on a PD decode server.` — флаг попал на prefill или монолит.
- `ValueError: --disaggregation-decode-retraction-backup=host_pool does not support --dcp-size > 1.` и `... requires --disable-priority-preemption when priority scheduling is enabled.` — конфликты, снимаемые только сменой конфигурации.
- `ValueError: The arguments disaggregation-decode-enable-offload-kvcache and disaggregation-decode-retraction-backup=host_pool are mutually exclusive ...` — уберите один из двух.
- `ValueError: --disaggregation-decode-retraction-backup=host_pool requires an MHA or hybrid-SWA HiCache host stack.`, `Host-pool retraction does not support Mamba models.` / `... pure-SWA models.` — модель несовместима, используйте `cpu_tensor`.
- `ValueError: Retraction host pool is smaller than its device pool: pool=..., host_slots=..., device_slots=... Increase --hicache-ratio or --hicache-size.` — хостовый пул задан меньше пула устройства.
- `RuntimeError: Retraction host KV pool exhausted after reclaim: request=..., required_slots=..., available_slots=...` в рантайме — пул исчерпан и после вытеснения кеш-записей; отката в `cpu_tensor` нет, увеличивайте `--hicache-ratio`/`--hicache-size`.
- Заданное в CLI значение видно в дампе `server_args=` при старте (у неуказанного аргумента там `None` — выведенный backend ложится на конфигурацию позже, в `kv_cache_builder`).
- Незаметный рост RAM при `cpu_tensor` под волной вытеснений — ожидаемое поведение, а не утечка: копии живут до возобновления или abort'а запроса. Для arriero это довод учесть пиковые копии в host-draw инстанса (`docs/RESOURCE_MANAGEMENT.md`, документ arriero).

## Примеры

Decode-сервер с явным зарезервированным пулом (host ≥ device обеспечен ratio 1.0 по умолчанию; здесь задан с запасом):

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --disaggregation-decode-retraction-backup host_pool --hicache-ratio 1.5
```

Экономия RAM ценой разовых аллокаций на каждое вытеснение:

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --disaggregation-decode-retraction-backup cpu_tensor
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/common.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- https://github.com/sgl-project/sglang/pull/34801 — «[PD] Preserve decode KV across retraction in HiCache», commit `2e7c85da68`, вводит аргумент и весь механизм
- `docs/RESOURCE_MANAGEMENT.md` — документ arriero о host-draw инстанса
