---
schema: 1
engine: vllm
primaryName: "--kv-offloading-backend"
title: "--kv-offloading-backend"
summary: Выбирает реализацию выгрузки KV-cache — встроенную CPU-выгрузку vLLM или внешний LMCache. Сам по себе ничего не включает: без --kv-offloading-size значение не читается.
group: CacheConfig
related:
  - --kv-offloading-size
  - --kv-transfer-config
  - --enable-prefix-caching
  - --disable-hybrid-kv-cache-manager
---

# --kv-offloading-backend

## Кратко

Аргумент выбирает, какой KV-connector будет подставлен в `kv_transfer_config`, когда выгрузка включена. Включает выгрузку **другой** аргумент — `--kv-offloading-size`; пока он `None`, `--kv-offloading-backend` не читается вообще.

Два значения ведут себя принципиально по-разному: `native` — это внутренняя выгрузка vLLM в pinned host memory, размер которой вы задаете сами; `lmcache` — внешний процесс LMCache, где емкостью управляет он, а не vLLM.

## Оригинальная справка

```text
The backend to use for KV cache offloading. Supported backends include
'native' (vLLM native CPU offloading), 'lmcache'.
KV offloading is only activated when kv_offloading_size is set.
```

## Паспорт аргумента

- Флаги: `--kv-offloading-backend`
- Группа argparse: `CacheConfig`
- Тип значения: enum (строка)
- Допустимые значения: `native`, `lmcache` (тип `KVOffloadingBackend` в `vllm/config/cache.py`)
- Значение по умолчанию: `native`
- Эффективное значение: внутри `native` конкретный connector дополнительно зависит от переменной окружения — `SimpleCPUOffloadConnector` при `VLLM_USE_SIMPLE_KV_OFFLOAD=1`, иначе `OffloadingConnector`
- Где объявлен: `vllm/config/cache.py:CacheConfig.kv_offloading_backend`
- Этап применения: `VllmConfig.__post_init__` → `_post_init_kv_transfer_config()`

## Что меняет в движке

Единственное место чтения — `_post_init_kv_transfer_config()`:

- `native`: `kv_transfer_config.kv_connector` становится `OffloadingConnector` (либо `SimpleCPUOffloadConnector` при `VLLM_USE_SIMPLE_KV_OFFLOAD=1`), а в `kv_connector_extra_config` записывается `cpu_bytes_to_use = kv_offloading_size × 2³⁰`;
- `lmcache`: `kv_transfer_config.kv_connector` становится `LMCacheMPConnector`; `kv_offloading_size` **не пробрасывается**, потому что емкость хранилища держит отдельный процесс LMCache. Хост и порт берутся из `kv_connector_extra_config`, по умолчанию `tcp://localhost:5555`;
- в обоих случаях `kv_role` выставляется в `kv_both`.

Дальше выбранный connector влияет на решение про hybrid KV cache manager: если `--disable-hybrid-kv-cache-manager` не задан явно и connector не реализует `SupportsHMA`, менеджер выключается с предупреждением; при явном включении HMA в такой конфигурации старт падает.

Для `native` реализация `OffloadingConnector` поддерживает многотиерную схему через `CPUOffloadingSpec`/`TieringOffloadingSpec`, но выбирается она уже ключами `kv_connector_extra_config`, а не этим флагом. По апстрим-документации `OffloadingConnector` работает только на CUDA, ROCm и XPU.

## Значения и формат

- `native` — встроенная выгрузка в pinned host memory. Размер задается `--kv-offloading-size` и делится между rank'ами.
- `lmcache` — внешний LMCache в multi-process режиме. Требует установленного LMCache и запущенного сервера; размер буфера vLLM не контролирует.
- Других значений нет; `None` не принимается (аргумент не `optional`).

## Когда использовать

- `native` — обычный выбор для одной машины: не нужен внешний процесс, вся конфигурация в одной командной строке.
- `lmcache` — когда кэш нужно разделить между несколькими инстансами vLLM или вынести на отдельный узел; тогда емкостью и политикой вытеснения управляет LMCache, и `--kv-offloading-size` для него бессмыслен.
- Не задавайте флаг без `--kv-offloading-size`: он ничего не сделает и создаст ложное впечатление, что выгрузка включена.
- Для сложных схем (несколько тиров, диск, собственные политики) флага недостаточно — переходите на явный `--kv-transfer-config`.

## Влияние на производительность и память

- **RAM хоста.** Для `native` — ровно `--kv-offloading-size` GiB pinned-памяти. Для `lmcache` — сколько скажет внешний процесс; vLLM этого не знает и не резервирует.
- **Пропускная способность.** Оба варианта переносят завершенные блоки за пределы GPU; `native` использует DMA-передачи асинхронно с вычислениями, `lmcache` добавляет межпроцессное взаимодействие.
- **VRAM.** Не меняется.
- **Время старта.** Для `native` — время аллокации и пиннинга буфера; для `lmcache` — установление связи с сервером.

## Взаимодействие с другими аргументами

- `--kv-offloading-size`: обязателен, чтобы значение вообще прочиталось. Для `lmcache` он работает только как выключатель — само число не используется.
- `--kv-transfer-config`: более низкий и более выразительный слой; этот флаг лишь заполняет его поля. При одновременном использовании поля `kv_connector`, `kv_role` и (для `native`) `cpu_bytes_to_use` перезаписываются производными значениями.
- `--enable-prefix-caching`: механизм выгрузки построен поверх prefix caching.
- `--disable-hybrid-kv-cache-manager`: связан через проверку `SupportsHMA` выбранного connector'а.

## Типовые проблемы и диагностика

- **Симптом:** `--kv-offloading-backend lmcache` задан, но ничего не происходит. **Причина:** не задан `--kv-offloading-size`, поэтому `_post_init_kv_transfer_config()` вышла на первой же строке. **Лечение:** добавить `--kv-offloading-size` (для `lmcache` значение служит только выключателем).
- **Симптом:** старт падает на импорте или подключении LMCache. **Причина:** пакет не установлен либо сервер не поднят на `tcp://localhost:5555`. **Лечение:** установить LMCache и запустить сервер либо переопределить хост/порт через `kv_connector_extra_config` в `--kv-transfer-config`.
- **Симптом:** предупреждение об отключении hybrid KV cache manager. **Причина:** выбранный connector не поддерживает HMA. **Последствие:** для моделей со скользящим окном — просадка производительности, для гибридных SSM-моделей — отказ старта.
- **Подтверждение:** строка `Creating v1 connector with name: <ConnectorClass> and engine_id: ...` в логе старта показывает, какой connector в итоге выбран.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --kv-offloading-size 32 --kv-offloading-backend native
```

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --kv-offloading-size 1 --kv-offloading-backend lmcache
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/factory.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/v1/simple_cpu_offload_connector.py`
- `vllm/vllm/v1/kv_offload/cpu/spec.py`
- `vllm/vllm/envs.py`
- `vllm/docs/features/kv_offloading_usage.md`
