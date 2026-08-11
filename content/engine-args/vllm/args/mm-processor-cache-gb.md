---
schema: 1
engine: vllm
primaryName: "--mm-processor-cache-gb"
title: "--mm-processor-cache-gb"
summary: Размер кэша результатов мультимодального препроцессинга. Это память **хоста** (или POSIX shared memory при `shm`), причём выделяемая в каждом API- и engine-процессе, поэтому 4 GiB по умолчанию на многопроцессной конфигурации превращаются в десятки гигабайт RAM.
group: MultiModalConfig
related:
  - --mm-processor-cache-type
  - --mm-shm-cache-max-object-size-mb
  - --mm-hasher-algorithm
  - --api-server-count
  - --data-parallel-size
  - --renderer-num-workers
  - --enable-prefix-caching
  - --limit-mm-per-prompt
---

# --mm-processor-cache-gb

## Кратко

Кэш хранит **результат работы HF-процессора** — уже развёрнутые тензоры (`pixel_values` и спутники) плюс prompt updates — под ключом `mm_hash` от содержимого медиа. Он избавляет от повторного декодирования и препроцессинга одной и той же картинки в многоходовом диалоге и от повторной передачи её между процессами.

Это **не VRAM**. При `lru` кэш живёт в куче Python-процессов, при `shm` — в POSIX shared memory. И он не один: справка прямо пишет, что суммарный расход считается как `mm_processor_cache_gb * (api_server_count + data_parallel_size)`.

## Оригинальная справка

```text
The size (in GiB) of the multi-modal processor cache, which is used to
avoid re-processing past multi-modal inputs.

This cache is duplicated for each API process and engine core process,
resulting in a total memory usage of
`mm_processor_cache_gb * (api_server_count + data_parallel_size)`.

Set to `0` to disable this cache completely (not recommended).
```

## Паспорт аргумента

- Флаги: `--mm-processor-cache-gb`
- Группа argparse: `MultiModalConfig`
- Тип значения: float, гибибайты
- Допустимые значения: `Field(default=4, ge=0)` — любое неотрицательное число
- Значение по умолчанию: `4` (GiB)
- Эффективное значение: принудительно `0` для encoder-decoder моделей (`Encoder-decoder model detected, disabling mm processor cache.`); кэш вообще не создаётся, если мультимодальные входы выключены конфигурацией (`--language-model-only`, все лимиты 0 без `--enable-mm-embeds`)
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_processor_cache_gb`
- Этап применения: инициализация рендерера в API-процессе и приёмного кэша в engine/worker-процессе

## Что меняет в движке

`MultiModalRegistry._get_cache_type()` (`vllm/multimodal/registry.py`) решает, какой кэш создать:

1. мультимодальные входы выключены → кэша нет;
2. `mm_processor_cache_gb <= 0` → кэша нет;
3. IPC-кэширование возможно только при `_api_process_count == 1` и (`data_parallel_size == 1` либо внешний LB). Иначе создаётся `processor_only` кэш;
4. иначе берётся `--mm-processor-cache-type`.

Дальше значение превращается в ёмкость конкретной реализации:

- `MultiModalProcessorOnlyCache` и `MultiModalProcessorSenderCache` — LRU по «весу» элемента, ёмкость `mm_processor_cache_gb` GiB (`MultiModalCache.get_lru_cache`);
- `MultiModalReceiverCache` в engine-процессе — такой же LRU той же ёмкости;
- `ShmObjectStoreSenderCache`/`ShmObjectStoreReceiverCache` — кольцевой буфер в разделяемой памяти с `data_buffer_size = int(mm_processor_cache_gb * GiB)`.

Раскладка «что где лежит» в апстрим-документации (`docs/configuration/optimization.md`, раздел Cache Placement):

| тип | P0 (API) | P1 (engine) | P1 (worker) | максимум памяти |
| --- | --- | --- | --- | --- |
| `lru`, processor caching | ключи + данные | — | — | `gb × data_parallel_size` |
| `lru`, key-replicated | ключи | ключи + данные | — | `gb × api_server_count` |
| `shm` | ключи | — | данные | `gb × api_server_count` |
| выключен | — | — | — | 0 |

Есть ещё один побочный эффект нуля: `Renderer._process_mm_uuids` при `mm_processor_cache_gb == 0` **и** выключенном prefix caching перестаёт идентифицировать медиа по содержимому и назначает синтетические uuid вида `<mm_req_id>-<modality>-<index>`, перекрывая даже те, что прислал клиент. Логика простая: переиспользовать всё равно нечего.

## Значения и формат

- Число в GiB, дробное допустимо (`--mm-processor-cache-gb 0.5`).
- `0` — кэш полностью выключен: ни processor caching, ни IPC caching. Справка помечает это как «not recommended».
- Отрицательные значения отвергает pydantic (`ge=0`).
- Значение задаёт ёмкость **одного** экземпляра кэша, а не суммарную по деплою.
- Для `shm` это размер кольцевого буфера в разделяемой памяти; он выделяется при старте, а не растёт по мере надобности.

## Когда использовать

- Многоходовые диалоги с картинками (типичный чат-ассистент): кэш здесь окупается напрямую, дефолтные 4 GiB трогать не нужно.
- Понижайте, когда на хосте кончается RAM. Считайте не 4 GiB, а `4 × (api_server_count + data_parallel_size)`; при `--api-server-count 4` это уже 20 GiB на дефолте.
- Повышайте, когда `MM cache hit rate` в периодическом логе низкий, а трафик заведомо повторяющийся (один и тот же документ в серии запросов).
- Ставьте `0` для одноразового трафика: batch-обработка, где каждая картинка встречается ровно один раз. Кэш там только тратит RAM и время на хеширование.
- В arriero расход этого кэша ложится на host-пул памяти инстанса (`config/resources.json`, `docs/RESOURCE_MANAGEMENT.md`): при `--api-server-count > 1` не забудьте умножить, иначе draw инстанса будет занижен.

## Влияние на производительность и память

- **RAM хоста.** Основная статья. `lru`: до `gb` в каждом задействованном процессе. `shm`: `gb` разделяемой памяти (учитывается в `/dev/shm`), плюс небольшой словарь prompt updates в P0.
- **VRAM.** Не влияет. Кэш хранит вход энкодера, а не его выход; encoder cache на устройстве — отдельная сущность, размер которой задаётся `--max-num-batched-tokens`.
- **Latency.** Попадание убирает и препроцессинг, и передачу тензора между процессами; на крупных изображениях это десятки миллисекунд.
- **Throughput.** Через экономию CPU в API-процессе — на мультимодальной нагрузке препроцессинг часто и есть узкое место.
- **Время старта.** При `shm` кольцевой буфер создаётся сразу, то есть заявленный объём разделяемой памяти занимается при старте.

## Взаимодействие с другими аргументами

- `--mm-processor-cache-type`: выбирает реализацию (`lru`/`shm`) для той же ёмкости.
- `--mm-shm-cache-max-object-size-mb`: потолок на один объект внутри `shm`-буфера; задавать его при `lru` — ошибка конфигурации.
- `--mm-hasher-algorithm`: чем считается ключ кэша.
- `--api-server-count`, `--data-parallel-size`: множители суммарного расхода; кроме того, `api_server_count > 1` (и DP без внешнего LB) отключает IPC-кэширование, оставляя только processor-only кэш.
- `--data-parallel-external-lb`: возвращает возможность IPC-кэширования при DP > 1.
- `--renderer-num-workers`: значение > 1 вместе с включённым кэшем на pooling-модели запрещено — движок падает с требованием либо вернуть `1`, либо поставить `--mm-processor-cache-gb 0`.
- `--enable-prefix-caching`: при нуле здесь и выключенном prefix caching движок перестаёт хешировать медиа по содержимому и подменяет пользовательские uuid.
- `--limit-mm-per-prompt`: при полном обнулении модальностей кэш не создаётся вовсе.

## Типовые проблемы и диагностика

- **Симптом:** хост уходит в swap после увеличения `--api-server-count`. **Причина:** кэш дублируется по процессам. **Лечение:** поделить значение на число процессов или перейти на `shm`.
- **Симптом:** `Cannot use --renderer-num-workers > 1 with the multimodal processor cache enabled for pooling models.` **Причина:** кэш не потокобезопасен для pooling-препроцессинга на воркерах рендерера. **Лечение:** `--renderer-num-workers 1` или `--mm-processor-cache-gb 0`.
- **Симптом:** в debug-логе `mm_input <hash> not cached; shm cache full, consider raising --mm-processor-cache-gb.` **Причина:** кольцевой буфер `shm` заполнен, а защищённые элементы мешают вытеснению. **Лечение:** увеличить значение.
- **Симптом:** `MM cache hit rate` близок к нулю при повторяющемся трафике. **Причина:** ключ считается по содержимому, а клиент присылает байты, отличающиеся ре-кодированием; либо кэш слишком мал и всё вытесняется. **Проверка:** метрики `vllm:mm_cache_queries` / `vllm:mm_cache_hits` в `/metrics`.
- **Подтверждение принятого значения:** периодическая строка логгера с `MM cache hit rate: X.X%` появляется только когда кэш создан; её отсутствие означает, что кэша нет (ноль, encoder-decoder модель или выключенная мультимодальность).

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-cache-gb 8 --limit-mm-per-prompt '{"image": 4}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-cache-gb 0 --api-server-count 4
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/multimodal/cache.py`
- `vllm/vllm/multimodal/registry.py`
- `vllm/vllm/renderers/base.py`
- `vllm/vllm/v1/metrics/loggers.py`
- `vllm/docs/configuration/optimization.md`
- `vllm/docs/configuration/conserving_memory.md`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
