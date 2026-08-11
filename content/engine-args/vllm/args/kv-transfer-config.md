---
schema: 1
engine: vllm
primaryName: "--kv-transfer-config"
title: "--kv-transfer-config"
summary: JSON-объект `KVTransferConfig` — подключает KV-коннектор: разнесение prefill и decode по разным инстансам, выгрузку KV на CPU/диск или внешний кэш. Для одиночного локального сервера не нужен; `--kv-offloading-size` заполняет его автоматически.
group: VllmConfig
related:
  - --kv-offloading-size
  - --kv-offloading-backend
  - --kv-events-config
  - --enable-prefix-caching
  - --disable-hybrid-kv-cache-manager
  - --enable-cumem-allocator
  - --enable-sleep-mode
  - --enable-return-routed-experts
  - --async-scheduling
---

# --kv-transfer-config

## Кратко

`--kv-transfer-config` заполняет `KVTransferConfig` (`vllm/config/kv_transfer.py`) — точку подключения KV-коннектора. Коннектор решает, откуда берутся и куда уходят блоки KV-cache: другой инстанс vLLM (схема prefill/decode disaggregation), CPU-память, файловая система, объектное хранилище или внешний сервис вроде LMCache.

Для одного локального сервера это не нужно. Флаг появляется в трех сценариях: разнесенные P/D-инстансы, выгрузка KV за пределы GPU и общий кэш префиксов между несколькими процессами. Во всех трех он меняет поведение планировщика и вводит зависимость от внешнего компонента.

## Оригинальная справка

```text
The configurations for distributed KV cache transfer.
```

## Паспорт аргумента

- Флаги: `--kv-transfer-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--kv-transfer-config.<поле> <значение>`)
- Допустимые значения: поля `KVTransferConfig`; имя коннектора — не статический список
- Значение по умолчанию: `None` — коннектор не подключается
- Эффективное значение: `VllmConfig._post_init_kv_transfer_config()` создает объект **сам**, если задан `--kv-offloading-size`: при `--kv-offloading-backend native` подставляется коннектор `OffloadingConnector` (или `SimpleCPUOffloadConnector` при `VLLM_USE_SIMPLE_KV_OFFLOAD=1`) вместе с `cpu_bytes_to_use`, при `lmcache` — `LMCacheMPConnector`; в обоих случаях `kv_role` принудительно становится `kv_both`. Кроме того, `engine_id` заполняется случайным UUID, а `kv_buffer_device` — типом устройства текущей платформы
- Где объявлен: `vllm/config/vllm.py:VllmConfig.kv_transfer_config`
- Этап применения: разбор CLI → `VllmConfig.__post_init__` (доопределение и проверки совместимости) → создание коннектора в планировщике и в каждом воркере → каждый запрос

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `kv_connector` | `None` | имя класса коннектора из реестра `KVConnectorFactory` |
| `kv_role` | `None` | `kv_producer` (обычно prefill-инстанс), `kv_consumer` (decode-инстанс) или `kv_both` (выгрузка/общий кэш). Обязателен, если задан `kv_connector` |
| `kv_connector_module_path` | `None` | путь к модулю для коннектора вне дерева vLLM |
| `kv_connector_extra_config` | `{}` | произвольные параметры конкретного коннектора |
| `engine_id` | `None` → случайный UUID | идентификатор инстанса в обмене KV |
| `kv_buffer_device` | тип устройства платформы | где коннектор держит буфер: `cuda`, `cpu`, `xpu` |
| `kv_buffer_size` | `1e9` | размер буфера в байтах для `TorchDistributedConnector` |
| `kv_rank` | `None` | ранг инстанса: 0 для prefill, 1 для decode (поддерживается только 1P1D) |
| `kv_parallel_size` | `1` | число параллельных инстансов в обмене |
| `kv_ip`, `kv_port` | `127.0.0.1`, `14579` | адрес для установления соединения |
| `enable_permute_local_kv` | `false` | экспериментальный перевод раскладки HND → NHD при передаче |
| `kv_load_failure_policy` | `"fail"` | что делать при неудачной загрузке KV: `fail` — сразу завершить запрос ошибкой, `recompute` — перепланировать и пересчитать неудавшиеся блоки |

Подключение коннектора меняет тракт планировщика: появляется отложенное освобождение блоков при нескольких одновременных батчах у консьюмера (`defer_block_free`), учет статистики префикс-кэша коннектора и требование доставки KV перед завершением запроса. `compute_hash()` возвращает хеш пустого списка — на граф вычислений и кэш компиляции конфиг не влияет.

## Значения и формат

- Обе формы: `--kv-transfer-config '{"kv_connector":"OffloadingConnector","kv_role":"kv_both"}'` и `--kv-transfer-config.kv_connector OffloadingConnector`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- Значение валидируется на разборе CLI как датакласс: неизвестный ключ или недопустимая роль отвергаются сразу.
- **Список коннекторов собирается в runtime** из реестра `KVConnectorFactory` (`vllm/distributed/kv_transfer/kv_connector/factory.py`) и расширяется через `kv_connector_module_path` — статического перечня нет. В дереве зарегистрированы, в частности, `OffloadingConnector`, `LMCacheConnectorV1`, `LMCacheMPConnector`, `NixlConnector`, `MooncakeConnector`, `MultiConnector`; актуальный список для вашей сборки — в этом файле реестра.
- `kv_role` без `kv_connector` допустим (ничего не включает), обратное — нет.
- Опечатка в имени коннектора обнаруживается не на разборе CLI, а при создании коннектора: `Unsupported connector type: X`.

## Когда использовать

- **Разнесение prefill и decode (P/D disaggregation).** Prefill-инстанс с `kv_role: "kv_producer"`, decode-инстанс с `kv_role: "kv_consumer"`; коннектор передает KV между ними. Имеет смысл на нескольких машинах или картах, а не на одном GPU.
- **Выгрузка KV за пределы GPU.** Практически всегда правильнее задавать `--kv-offloading-size` и `--kv-offloading-backend` — они соберут этот конфиг сами и корректно.
- **Общий кэш префиксов между процессами** через LMCache или объектное хранилище.
- **Не включайте для одного локального инстанса.** Коннектор добавляет сетевой или дисковый компонент в горячий путь и меняет семантику освобождения блоков; выигрыш появляется только при реальном переиспользовании KV между процессами.
- **Не используйте одновременно с `--enable-return-routed-experts`** — комбинация отвергается явной ошибкой.

## Влияние на производительность и память

- **VRAM.** Сам конфиг памяти не занимает, но `kv_buffer_device: "cuda"` и `kv_buffer_size` резервируют буфер на карте. Выгрузка KV на CPU, наоборот, освобождает VRAM ценой пропускной способности PCIe.
- **RAM хоста.** При `OffloadingConnector` объем задается через `cpu_bytes_to_use` (или `--kv-offloading-size`); это прямой расход хостовой памяти, который в arriero надо декларировать в host-пуле — см. `docs/RESOURCE_MANAGEMENT.md` (документ arriero).
- **Latency.** Загрузка блоков из внешнего хранилища добавляется к TTFT; выигрыш возникает только когда пересчет prefill дороже переноса.
- **Throughput.** У консьюмера при нескольких одновременных батчах включается отложенное освобождение блоков — эффективная емкость KV-cache немного снижается.
- **Время старта.** Инициализация коннектора (соединение, регистрация памяти) выполняется до готовности сервера.

## Взаимодействие с другими аргументами

- `--kv-offloading-size`, `--kv-offloading-backend`: создают и заполняют этот конфиг автоматически. Если вы задали и то и другое, ваши `kv_connector`/`kv_role` будут перезаписаны логикой выгрузки.
- `--enable-prefix-caching`: коннекторы работают в терминах блоков префикс-кэша; при выключенном кэшировании смысл большинства сценариев теряется.
- `--kv-events-config`: публикация событий о блоках; часто включается вместе с коннектором, чтобы внешний индекс знал, где какие блоки лежат.
- `--enable-cumem-allocator`, `--enable-sleep-mode`: единственное исключение из запрета на `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (см. диагностику).
- `--disable-hybrid-kv-cache-manager`: гибридный менеджер KV автоматически отключается для части конфигураций с коннектором.
- `--async-scheduling`: вместе с ролью консьюмера включает отложенное освобождение блоков.
- `--enable-return-routed-experts`: несовместим с любым KV-коннектором.

## Типовые проблемы и диагностика

- **Симптом:** `Please specify kv_role when kv_connector is set, supported roles are ...` (движок перечисляет их в сообщении). **Лечение:** добавить `kv_role`.
- **Симптом:** `Unsupported kv_role: X.` **Лечение:** одно из `kv_producer`, `kv_consumer`, `kv_both`.
- **Симптом:** `Unsupported connector type: X` при старте. **Причина:** коннектора нет в реестре этой сборки. **Лечение:** сверить имя с `vllm/distributed/kv_transfer/kv_connector/factory.py` или задать `kv_connector_module_path`.
- **Симптом:** `KV connector X is incompatible with PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True unless enable_cumem_allocator is also enabled.` **Причина:** VMM-аллокатор PyTorch может переотобразить виртуальные адреса KV-cache, ломая зарегистрированные RDMA-регионы. **Лечение:** убрать `expandable_segments:True` или включить `--enable-cumem-allocator`.
- **Симптом:** `--enable-return-routed-experts is incompatible with KV connectors (PD disaggregation, KV cache offload).` **Лечение:** оставить что-то одно.
- **Симптом:** `Encoder-decoder models are not currently supported with KV connectors` (assert в планировщике). **Лечение:** не использовать коннектор с encoder-decoder моделью.
- **Симптом:** запросы падают при недоступности удаленного KV. **Причина:** `kv_load_failure_policy` по умолчанию `fail`. **Лечение:** `recompute`, если пересчет предпочтительнее ошибки.
- **Подтверждение принятого значения:** строка `Creating connector with name: X and engine_id: ...` в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --kv-offloading-size 16 --kv-offloading-backend native --enable-prefix-caching
```

```bash
vllm serve /models/Qwen3-4B --kv-transfer-config '{"kv_connector":"OffloadingConnector","kv_role":"kv_both","kv_connector_extra_config":{"cpu_bytes_to_use":17179869184}}'
```

## Источники

- `vllm/vllm/config/kv_transfer.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/factory.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/docs/features/disagg_prefill.md`
- `vllm/docs/features/kv_offloading_usage.md`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
