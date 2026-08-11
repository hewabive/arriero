---
schema: 1
engine: vllm
primaryName: "--mm-processor-cache-type"
title: "--mm-processor-cache-type"
summary: Где физически лежат закэшированные тензоры препроцессинга: в куче engine-процесса (`lru`) или в POSIX shared memory, доступной всем воркерам (`shm`). При TP > 1 второй вариант убирает дублирование данных по рангам.
group: MultiModalConfig
related:
  - --mm-processor-cache-gb
  - --mm-shm-cache-max-object-size-mb
  - --tensor-parallel-size
  - --api-server-count
  - --data-parallel-size
  - --data-parallel-external-lb
  - --distributed-executor-backend
---

# --mm-processor-cache-type

## Кратко

Оба значения хранят одно и то же — результат HF-препроцессинга, ключом по `mm_hash`. Разница в размещении:

- `lru` (по умолчанию) — «зеркальный» LRU: в API-процессе (P0) лежат только ключи и метаданные размера, сами тензоры — в engine-процессе (P1). Между процессами передаётся либо тензор (промах), либо ничего (попадание).
- `shm` — кольцевой буфер в разделяемой памяти: P0 хранит ключи, данные пишет в shm, а воркеры читают их оттуда напрямую по адресу. При TP > 1 тензор не рассылается каждому рангу.

Флаг вступает в силу только когда IPC-кэширование вообще возможно; иначе движок создаёт локальный processor-only кэш и значение игнорирует.

## Оригинальная справка

```text
Type of cache to use for the multi-modal preprocessor/mapper. If `shm`,
use shared memory FIFO cache. If `lru`, use mirrored LRU cache.
```

## Паспорт аргумента

- Флаги: `--mm-processor-cache-type`
- Группа argparse: `MultiModalConfig`
- Тип значения: enum (строка)
- Допустимые значения: `shm`, `lru` (`MMCacheType`)
- Значение по умолчанию: `lru`
- Эффективное значение: игнорируется, если IPC-кэширование недоступно (`_api_process_count != 1`, либо `data_parallel_size > 1` без внешнего LB) — тогда создаётся `MultiModalProcessorOnlyCache`; полностью не применяется при `--mm-processor-cache-gb 0`
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_processor_cache_type`
- Этап применения: инициализация рендерера (P0) и приёмного кэша воркера (P1)

## Что меняет в движке

`MultiModalRegistry.processor_cache_from_config()` разворачивает значение в конкретный класс:

- `lru` → `MultiModalProcessorSenderCache` в P0 (хранит только `MultiModalProcessorCacheItemMetadata` — размер элемента и prompt updates, чтобы политика вытеснения совпадала с P1) и `MultiModalReceiverCache` в P1 (хранит сами `MultiModalKwargsItem`);
- `shm` → `ShmObjectStoreSenderCache` в P0 и `ShmObjectStoreReceiverCache` в воркере. Оба открывают один `SingleWriterShmRingBuffer` с именем из `VLLM_OBJECT_STORAGE_SHM_BUFFER_NAME` (по умолчанию уникальное на дерево процессов) и размером `mm_processor_cache_gb × GiB`. Писатель один — P0; читателей ровно `parallel_config.world_size`.

При `shm` вместо тензора по IPC уходит пара «адрес + monotonic_id»; воркер читает данные из shm. Именно это делает режим выгодным при TP > 1: широковещательная рассылка тензора по рангам заменяется чтением из общей памяти.

`shm` требует, чтобы executor передал воркеру `shared_worker_lock`. Если этого не произошло, `WorkerBase` падает с `Missing shared_worker_lock argument from executor. This argument is needed for mm_processor_cache_type='shm'.` (при `lru` то же самое — просто предупреждение).

Кольцевой буфер работает по FIFO с проверкой «никто не читает»; отсюда «shared memory FIFO cache» в справке против «mirrored LRU» у `lru`.

## Значения и формат

- `lru` — дефолт. Никаких дополнительных требований к окружению.
- `shm` — использует POSIX shared memory; на хосте должно хватать `/dev/shm` под `--mm-processor-cache-gb`. Имя сегмента переопределяется переменной окружения `VLLM_OBJECT_STORAGE_SHM_BUFFER_NAME` (это env, не CLI-аргумент).
- Значение проверяется argparse по `choices`; опечатка отвергается сразу.
- `--mm-shm-cache-max-object-size-mb` разрешено задавать **только** при `shm`: иначе валидатор конфига бросает `'mm_shm_cache_max_object_size_mb' should only be set when 'mm_processor_cache_type' is 'shm'.`

## Когда использовать

- `shm` при `--tensor-parallel-size > 1`: чем больше рангов, тем заметнее выигрыш — тензор перестаёт копироваться в каждый воркер. Апстрим-документация рекомендует именно этот сценарий.
- `shm` при крупных медиа (видео, большие изображения): экономится не только трафик IPC, но и пиковая RSS на сериализации.
- `lru` для одиночного GPU без TP: проще, никаких требований к `/dev/shm`, меньше подвижных частей.
- Не трогайте флаг, если у вас `--api-server-count > 1` или DP без внешнего LB — IPC-кэша там нет, и значение всё равно не применится.
- Не выбирайте `shm` ради «экономии памяти»: суммарный объём тот же, меняется только его размещение и число копий.

## Влияние на производительность и память

- **RAM хоста.** `lru`: `--mm-processor-cache-gb` в engine-процессе плюс лёгкие метаданные в API-процессе. `shm`: тот же объём, но в разделяемой памяти, видимой в `/dev/shm`, и общий на всех воркеров.
- **VRAM.** Не влияет.
- **Latency.** `shm` убирает сериализацию/десериализацию крупного тензора при попадании и рассылку по TP-рангам; на видео это самый заметный эффект.
- **Throughput.** Растёт на мультимодальной нагрузке с TP > 1 за счёт снятия нагрузки с IPC.
- **Время старта.** `shm` создаёт кольцевой буфер сразу — заявленный объём разделяемой памяти занимается при старте.

## Взаимодействие с другими аргументами

- `--mm-processor-cache-gb`: задаёт ёмкость выбранной реализации; `0` отключает обе.
- `--mm-shm-cache-max-object-size-mb`: осмысленно и разрешено только при `shm`.
- `--tensor-parallel-size`: главный аргумент за `shm`; число читателей буфера равно `world_size`.
- `--api-server-count`: значение > 1 отключает IPC-кэширование, и тип кэша перестаёт применяться.
- `--data-parallel-size`, `--data-parallel-external-lb`: DP > 1 отключает IPC-кэширование, если не включён внешний балансировщик.
- `--distributed-executor-backend`: executor обязан передать воркеру `shared_worker_lock`; при экзотическом backend'е это первое, что стоит проверить при отказе `shm`.

## Типовые проблемы и диагностика

- **Симптом:** `Missing shared_worker_lock argument from executor. This argument is needed for mm_processor_cache_type='shm'.` **Причина:** executor не передал общий лок воркеру. **Лечение:** вернуться на `lru` либо сменить executor backend.
- **Симптом:** `'mm_shm_cache_max_object_size_mb' should only be set when 'mm_processor_cache_type' is 'shm'.` **Причина:** задан лимит объекта при `lru`. **Лечение:** убрать лимит или переключить тип.
- **Симптом:** предупреждение `mm_input <hash> too large to cache; raise --mm-shm-cache-max-object-size-mb.` **Причина:** объект не влез в лимит одного элемента. **Лечение:** поднять `--mm-shm-cache-max-object-size-mb`.
- **Симптом:** переключение на `shm` ничего не изменило. **Причина:** IPC-кэширование отключено (несколько API-процессов или DP без внешнего LB), работает processor-only кэш. **Проверка:** `--api-server-count` и `--data-parallel-size` в стартовой строке конфига.
- **Симптом:** нехватка места при старте с `shm`. **Причина:** `/dev/shm` меньше `--mm-processor-cache-gb`. **Лечение:** уменьшить значение или увеличить размер `/dev/shm` (в контейнере это отдельный параметр рантайма, `shm-size`).
- **Подтверждение принятого значения:** строка стартового конфига содержит `mm_processor_cache_type=...`; факт наличия кэша подтверждает `MM cache hit rate: X.X%` в периодическом логе.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --tensor-parallel-size 2 --mm-processor-cache-type shm --mm-processor-cache-gb 8
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-cache-type lru --mm-processor-cache-gb 4
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/cache.py`
- `vllm/vllm/multimodal/registry.py`
- `vllm/vllm/distributed/device_communicators/shm_object_storage.py`
- `vllm/vllm/v1/worker/worker_base.py`
- `vllm/vllm/envs.py`
- `vllm/docs/configuration/optimization.md`
