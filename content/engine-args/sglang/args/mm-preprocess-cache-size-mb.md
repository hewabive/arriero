---
schema: 1
engine: sglang
primaryName: "--mm-preprocess-cache-size-mb"
title: "--mm-preprocess-cache-size-mb"
summary: Задаёт общий CPU-бюджет content-addressed кеша результатов мультимодального preprocessing. Бюджет делится между tokenizer-процессами; `0` отключает хранение, а незаданное значение сейчас автоматически даёт 256 МиБ только процессору Kimi-K3.
group: mm
related:
  - --trust-mm-content-hashes
  - --tokenizer-worker-num
  - --mm-processor-worker-num
  - --mm-process-config
  - --enable-mm-global-cache
---

# --mm-preprocess-cache-size-mb

## Кратко

Кеш сохраняет prompt-independent media artifacts после decode/resize/preprocess и повторно использует их по SHA-256 содержимого, fingerprint процессора и preprocess options. Это CPU LRU до ViT/encoder, а не KV-cache и не глобальный embedding cache.

В текущем checkout общий cache contract реализован в `MediaArtifactCacheMixin`, а model-specific opt-in есть у Kimi-K3 image processor. Для остальных процессоров явный бюджет сам по себе не добавляет artifact implementation.

## Оригинальная справка

```text
CPU memory budget for content-addressed multimodal preprocessing artifacts. Unset selects a model-specific default (256 MiB for Kimi-K3); 0 disables the cache. The budget is divided across tokenizer workers and does not reserve GPU memory.
```

## Паспорт аргумента

- Флаги: `--mm-preprocess-cache-size-mb`
- Группа: `mm`
- Тип значения: `Optional[int]`
- Значение по умолчанию: `null`; выбирается `auto_mm_preprocess_cache_size_mb` класса процессора (`256` для Kimi-K3, `0` в базовом классе)
- Допустимые значения: неотрицательные целые; отрицательное отвергается в `ServerArgs._handle_multimodal`
- Где объявлен: `ServerArgs.mm_preprocess_cache_size_mb`
- Этап применения: создание мультимодального процессора → cache lookup/single-flight до media decode/preprocess → LRU insert/eviction

## Что меняет в движке

`SGLangBaseProcessor` делит service-wide число МиБ на `max(tokenizer_worker_num, 1)` и создаёт в каждом tokenizer-процессе `MultimodalPreprocessCache` с этим per-worker budget и максимумом 8192 entries.

Ключ включает digest исходного media, modality, fingerprint модели/процессора и request-level preprocessing kwargs. Поэтому одинаковые bytes с другими resize/detail options не смешиваются. Одновременные misses одного ключа объединяются single-flight: вычисляет один request, остальные ждут его result.

LRU учитывает фактические bytes CPU tensors/arrays/images/containers. Artifact с GPU tensor или artifact крупнее всего per-worker budget не сохраняется. Flush очищает entries и повышает generation, чтобы уже запущенная работа не могла заново наполнить только что очищенный кеш.

## Значения и формат

- Не задан — model-specific default: 256 МиБ суммарно для Kimi-K3, 0 у базового процессора.
- `0` — отключает retention и вычисление processor fingerprint, но запросы продолжают preprocess обычным путём.
- Положительное число — суммарный бюджет в МиБ, который делится целочисленно между tokenizer workers.
- Лимит entries всегда 8192 на worker; фактическая граница обычно наступает по bytes.

## Когда использовать

- Оставляйте Kimi-K3 default, если одни и те же изображения повторяются и CPU preprocessing заметен в TTFT.
- Поднимайте бюджет при частых evictions и высокой доле повторов, только если host RAM имеет запас.
- Ставьте `0` для уникального media stream или когда cache key/hash работа дороже возможных hits.
- Не рассчитывайте этим флагом пропускать ViT между узлами: для готовых embeddings существует `--enable-mm-global-cache`.

## Влияние на производительность и память

Budget расходует только RAM хоста; GPU-backed artifact не принимается в LRU. Cache hit убирает media snapshot/decode и model-specific preprocessing, но не обязательно убирает encoder forward. Hashing содержимого и построение fingerprint добавляют CPU работу на miss; single-flight не даёт параллельным одинаковым запросам умножить preprocessing.

`--tokenizer-worker-num` не умножает заданный budget: 256 МиБ при двух workers становятся примерно по 128 МиБ на процесс. Однако лимит в 8192 entries применяется к каждому worker отдельно.

## Взаимодействие с другими аргументами

- `--trust-mm-content-hashes` разрешает hot hit по caller hash без чтения media; без него bytes всё равно читаются и hash проверяется.
- `--tokenizer-worker-num` делит общий byte budget между процессами; кеши между ними не общие.
- `--mm-processor-worker-num` управляет параллелизмом preprocessing, а single-flight cache координирует одинаковые keys.
- `--mm-process-config` участвует в fingerprint/key через preprocessing options, предотвращая reuse несовместимого artifact.
- `--enable-mm-global-cache` кеширует другой уровень — готовые encoder embeddings во внешнем store.

## Типовые проблемы и диагностика

- `mm_preprocess_cache_size_mb must be non-negative` — исправьте отрицательное значение.
- Нет hits после увеличения budget — процессор модели может не реализовать artifact cache либо запросы отличаются содержимым/preprocess kwargs.
- В логе `0 MiB per tokenizer worker` при маленьком общем budget и большом числе workers означает целочисленное деление до нуля; увеличьте budget или уменьшите workers.
- Стартовая строка `Multimodal preprocess cache enabled for ...: ... MiB total (... MiB per tokenizer worker), at most 8192 entries; caller content hashes are verified/trusted` подтверждает эффективный режим.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3-Instruct --mm-preprocess-cache-size-mb 512 --tokenizer-worker-num 2
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3-Instruct --mm-preprocess-cache-size-mb 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/kimi_k3.py`
- `sglang/python/sglang/srt/multimodal/cache/preprocess_cache.py`
- `sglang/python/sglang/srt/multimodal/cache/identity.py`
- `sglang/python/sglang/srt/multimodal/media_artifacts/base.py`
