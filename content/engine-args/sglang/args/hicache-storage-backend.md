---
schema: 1
engine: sglang
primaryName: "--hicache-storage-backend"
title: "--hicache-storage-backend"
summary: Подключает третий уровень HiCache — внешнее хранилище KV за пределами хоста. Большинство значений требуют стороннего пакета, которого нет в базовой установке, и падают при создании backend'а, а не при разборе аргументов.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-storage-backend-extra-config
  - --hicache-storage-prefetch-policy
  - --hicache-mem-layout
  - --hicache-write-policy
  - --dcp-size
  - --disaggregation-decode-enable-offload-kvcache
  - --admin-api-key
---

# --hicache-storage-backend

## Кратко

`--hicache-storage-backend` добавляет к HiCache уровень L3: общее хранилище, из которого несколько инстансов SGLang могут переиспользовать один и тот же префикс. Ключевая практическая деталь — из десяти допустимых значений только два (`file` и `shm`) работают на «голой» установке; остальные требуют внешних пакетов (`mooncake`, `nixl`, `aibrix_kvcache`, `eic`, `simm`, UMBP), и отсутствие пакета проявляется как `ImportError` при **создании** backend'а на старте сервера, а не как отказ argparse. Аргумент читается только при `--enable-hierarchical-cache` (либо при `--disaggregation-decode-enable-offload-kvcache`).

## Оригинальная справка

```text
The storage backend for hierarchical KV cache. Built-in backends: file, mooncake, hf3fs, nixl, aibrix. For dynamic backend, use --hicache-storage-backend-extra-config to specify: backend_name (custom name), module_path (Python module path), class_name (backend class name).
```

## Паспорт аргумента

- Флаги: `--hicache-storage-backend`
- Группа: `memory`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `file`, `mooncake`, `hf3fs`, `nixl`, `aibrix`, `dynamic`, `eic`, `simm`, `mori`, `shm`
- Значение по умолчанию: `null` — L3 не подключен, HiCache работает как двухуровневый (L1+L2)
- Эффективное значение: не переопределяется; но выбор backend'а меняет **другие** значения — `mooncake` переписывает `--hicache-mem-layout layer_first`, а `shm` (и `dynamic` с `"allocator": "shm"`) переключает аллокатор host-пула на shared memory
- Где объявлен: `ServerArgs.hicache_storage_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; конкретные backend'ы — сторонние интеграции разной зрелости
- Этап применения: `__post_init__` (`_handle_hicache`, `_handle_cache_compatibility`) → `HiCacheController.attach_storage_backend` при инициализации дерева кеша

## Что меняет в движке

Имя backend'а превращается в объект через `StorageBackendFactory.create_backend` (`sglang/python/sglang/srt/mem_cache/storage/backend_factory.py`). Все встроенные backend'ы зарегистрированы с **ленивой** загрузкой: модуль импортируется только в момент создания, поэтому недостающая зависимость всплывает на старте сервера в виде `ImportError: Failed to import backend '<name>' from '<module>'`.

После успешного создания `HiCacheController.attach_storage_backend`:

- поднимает `enable_storage`, задает порог prefetch (`max(prefetch_threshold, page_size)`, по умолчанию 256 токенов) и лимит спекулятивного prefetch в половину host-пула;
- создает выделенные gloo-группы для синхронизации prefetch между rank'ами;
- для backend'ов `hf3fs`, `mooncake`, `eic`, `nixl`, `simm`, `mori` (и `dynamic` с `interface_v1`) переключает чтение/запись страниц на zero-copy пути `_page_get_zero_copy` / `_page_set_zero_copy`;
- запускает фоновые потоки prefetch и backup.

Для MLA-моделей запись в L3 делает только rank 0 (`backup_skip` для остальных) — данные на всех rank'ах идентичны.

L3 не хранит метаданные в дереве: при обращении backend опрашивается в реальном времени (`sglang/docs/docs/advanced_features/hicache_design.mdx`).

## Значения и формат

- `file` — `HiCacheFile`, простой файловый backend. Каталог по умолчанию `/tmp/hicache`, переопределяется переменной окружения `SGLANG_HICACHE_FILE_BACKEND_STORAGE_DIR`; каталог создается на старте rank'ом 0. Апстрим прямо называет его демонстрационным. Внешних зависимостей нет.
- `shm` — не хранилище, а заглушка: `HiCacheShm` ничего не читает и не пишет, а сам факт выбора `shm` переключает аллокатор host-пула на shared memory (`get_allocator_type` в `mem_cache/pool_host/common.py`). Использовать как «L3» бессмысленно.
- `mooncake` — распределенное RDMA-хранилище; нужен пакет `mooncake-transfer-engine` и набор переменных `MOONCAKE_*`. Требует page-раскладки.
- `hf3fs` — DeepSeek 3FS через usrbio-клиент; конфигурация через `SGLANG_HICACHE_HF3FS_CONFIG_PATH` и extra-config.
- `nixl` — унифицированный доступ к плагинам (3FS, GDS, S3-совместимые); нужен пакет `nixl`.
- `aibrix` — `aibrix_kvcache`, импорт жесткий на уровне модуля.
- `eic`, `simm`, `mori` — интеграции сторонних систем (`eic`, `simm.kv`, UMBP); в `--help` они есть, в тексте справки не перечислены.
- `dynamic` — загрузка своего класса: обязательные ключи `backend_name`, `module_path`, `class_name` в `--hicache-storage-backend-extra-config`.
- Значение вне списка отвергает argparse; отсутствие флага означает «L3 нет».

## Когда использовать

- Несколько инстансов SGLang делят один пул горячих префиксов (общий системный промпт, RAG-контекст, длинные диалоги) — это и есть основной сценарий L3.
- PD-развертывание: prefill-узлы переиспользуют KV, отгруженный decode-узлами (`--disaggregation-decode-enable-offload-kvcache` требует заданного backend'а).
- Один локальный инстанс: L3 обычно не нужен — L2 в RAM и быстрее, и проще. `file` в этом случае имеет смысл разве что для функционального теста самого пути prefetch/backup.
- Не выбирайте backend, чья зависимость не установлена в окружении: сервер поднимется до момента создания backend'а и упадет там, потеряв время на загрузку весов.

## Влияние на производительность и память

- RAM хоста: сам backend буфер не выделяет, но лимит спекулятивного prefetch равен половине host-пула, то есть при активном L3 половина L2 может быть занята предзагрузкой.
- Диск/сеть: трафик определяется `--hicache-write-policy` (что попадает в L3) и `--hicache-storage-prefetch-policy` (сколько ждать при чтении).
- TTFT: при попадании в L3 экономится prefill, но добавляется ожидание сети/диска. Политика `wait_complete` дает максимальный hit rate ценой хвоста latency, `best_effort` — обратное.
- Старт: добавляются фоновые потоки prefetch/backup и gloo-группы синхронизации; при `--tp-size > 1` синхронизация prefetch делает `all_reduce` на каждый запрос.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: без него backend не подключается.
- `--hicache-mem-layout`: `mooncake` не принимает `layer_first` — layout автоматически переписывается; `page_head` нужен для heterogeneous-TP; `hf3fs` считает размер страницы по-разному в зависимости от layout.
- `--hicache-storage-backend-extra-config`: единственный способ передать backend'у его настройки, а для `dynamic` — обязательный.
- `--hicache-storage-prefetch-policy`: политика останова prefetch имеет смысл только при подключенном L3.
- `--hicache-write-policy`: определяет, что вообще доедет до L3 (запись в хранилище идет после подтверждения записи в L2).
- `--dcp-size` > 1: комбинация запрещена — `NotImplementedError` «--hicache-storage-backend (L3) with --dcp-size > 1 is not supported yet… Run HiCache+DCP with L1/L2 only.».
- `--disaggregation-decode-enable-offload-kvcache`: требует заданного backend'а, иначе `ValueError`.
- `--optimistic-prefill-attempts`: на prefill-узле PD молча отключается, если L3 подключен.
- `--admin-api-key`: при заданном ключе административные эндпоинты HiCache (`/hicache/storage-backend`, очистка) требуют именно его, а не `--api-key`.

## Типовые проблемы и диагностика

- `ImportError: Failed to import backend '<name>' from '<module>'` на старте — стороннего пакета нет в окружении. Это самая частая ошибка при работе с L3.
- `ValueError: Unknown storage backend '<name>'. Registered backends: [...]` — имя не зарегистрировано; для своего backend'а используйте `dynamic` плюс `backend_name`/`module_path`/`class_name`.
- `ValueError: Missing required field '<field>' in backend config for 'dynamic' backend` — неполный extra-config.
- `NotImplementedError` про `--dcp-size > 1` — снимите L3 либо DCP.
- Успешное подключение подтверждает строка «Creating storage backend '<name>' (<module>.<class>)» в логе; состояние в рантайме отдает `GET /hicache/storage-backend`.
- Backend можно подключить и отключить без перезапуска: `PUT /hicache/storage-backend` и `DELETE /hicache/storage-backend`; очистка — `POST /hicache/storage-backend/clear`. Эти операции требуют отсутствия запросов в полете.
- L3 доступен всем инстансам, которые видят хранилище: на сервере, открытом не только на localhost, общий namespace L3 — это канал утечки содержимого чужих префиксов. Разделяйте namespace или закрывайте доступ на уровне хранилища.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 3 --hicache-storage-backend file --hicache-storage-prefetch-policy timeout
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --page-size 64 --enable-hierarchical-cache --hicache-ratio 2 --hicache-mem-layout page_first_direct --hicache-io-backend direct --hicache-storage-backend hf3fs --hicache-storage-prefetch-policy wait_complete
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/storage/backend_factory.py`
- `sglang/python/sglang/srt/mem_cache/hicache_storage.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/common.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
- `sglang/docs/docs/advanced_features/hicache_storage_runtime_attach_detach.mdx`
