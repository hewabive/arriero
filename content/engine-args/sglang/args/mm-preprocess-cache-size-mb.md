---
schema: 1
engine: sglang
primaryName: "--mm-preprocess-cache-size-mb"
title: "--mm-preprocess-cache-size-mb"
summary: Бюджет CPU-памяти под content-addressed кеш артефактов мультимодального препроцессинга. Незаданный — модель-специфичный дефолт (256 МиБ у Kimi-K3, 0 у остальных), 0 выключает кеш; бюджет делится поровну между tokenizer-воркерами.
group: mm
related:
  - --trust-mm-content-hashes
  - --tokenizer-worker-num
  - --enable-mm-global-cache
  - --enable-prefix-mm-cache
  - --mm-processor-worker-num
  - --mm-process-config
---

# --mm-preprocess-cache-size-mb

## Кратко

Препроцессинг медиа — resize, нормализация, нарезка на патчи — детерминирован: одна и та же картинка при одних и тех же настройках дает один и тот же результат. `--mm-preprocess-cache-size-mb` задает бюджет CPU-памяти под кеш таких результатов, адресуемый SHA-256-хешем содержимого: повторная отправка того же медиа пропускает декодирование и препроцессинг целиком. Кешируется **артефакт** — модель-специфичное, независимое от промпта состояние одного медиа-входа (метаданные вроде размера и токенной сетки плюс, когда возможно, сама CPU-фича); это слой ниже кеша эмбеддингов энкодера (`--enable-mm-global-cache`) и выше radix-кеша префиксов.

## Оригинальная справка

```text
CPU memory budget for content-addressed multimodal preprocessing artifacts. Unset selects a model-specific default (256 MiB for Kimi-K3); 0 disables the cache. The budget is divided across tokenizer workers and does not reserve GPU memory.
```

## Паспорт аргумента

- Флаги: `--mm-preprocess-cache-size-mb`
- Группа: `mm`
- Тип значения: int, МиБ (`Optional[int]`)
- Значение по умолчанию: `null` — «модель-специфичный дефолт»
- Эффективное значение: разрешается в конструкторе `BaseMultimodalProcessor`: незаданное значение заменяется классовым атрибутом `auto_mm_preprocess_cache_size_mb` (0 в базовом классе, 256 у процессора Kimi-K3), затем итог делится на число tokenizer-воркеров
- Где объявлен: `ServerArgs.mm_preprocess_cache_size_mb`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_multimodal` — проверка неотрицательности) → конструирование мультимодального процессора в каждом tokenizer-процессе → каждый запрос с медиа

## Что меняет в движке

В конструкторе `BaseMultimodalProcessor` (`sglang/python/sglang/srt/multimodal/processors/base_processor.py`) создается `MultimodalPreprocessCache` — потокобезопасный LRU в CPU-памяти с single-flight на ключ: пока один запрос считает артефакт, конкурентные запросы с тем же медиа ждут его результат, а не считают повторно. Каждый tokenizer-воркер — отдельный процесс со своим кешем, поэтому запрошенный бюджет делится: `на_воркер = бюджет // --tokenizer-worker-num`. Увеличение числа воркеров не умножает расход памяти, но и уменьшает полезный объем каждого кеша. Вторая граница — не больше 8192 записей на воркер.

Ключ артефакта складывается из контентного хеша медиа (`sha256:<64 hex>`) и отпечатка процессора — версии и настроек препроцессинга (`build_processor_fingerprint`), так что смена конфигурации не подставит устаревший артефакт. Значение — `artifact.cache_value()`: метаданные всегда, CPU-фича — когда она кешируема; CUDA-тензоры в кеш не попадают, GPU-память не резервируется (о чем справка говорит прямо). «Безфичевый» артефакт полезен только если эмбеддинг уже лежит в кеше энкодера — это учитывается при выдаче.

`0` — полный выключатель: свойство `enabled` кеша ложно, и вместе с хранением отключается и вычисление ключей. `clear_preprocess_cache` вызывается при `/flush_cache`, так что кеш сбрасывается вместе с остальными.

При включенном кеше в лог печатается: `Multimodal preprocess cache enabled for <Processor>: N MiB total (M MiB per tokenizer worker), at most 8192 entries; caller content hashes are trusted|verified.` — последняя часть отражает `--trust-mm-content-hashes`.

## Значения и формат

- Неотрицательное целое, МиБ. Отрицательное — `ValueError: mm_preprocess_cache_size_mb must be non-negative` на старте.
- Не задан — дефолт процессора модели: 256 МиБ у Kimi-K3, 0 (кеш выключен) у остальных.
- `0` — кеш и вычисление ключей выключены явно, в том числе у Kimi-K3.
- Заданное значение — это **суммарный** бюджет сервиса; на каждый tokenizer-воркер приходится целочисленная доля. Значение меньше числа воркеров даст нулевую долю — кеш фактически выключен.

## Когда использовать

- Трафик с повторяющимися медиа: один и тот же документ/скриншот в серии запросов, few-shot-промпты с одинаковыми картинками, ретраи. Попадание экономит скачивание, декодирование и препроцессинг — самые дорогие CPU-этапы тракта.
- В связке с `--trust-mm-content-hashes` и клиентом, передающим `content_hash`: горячее попадание тогда не читает медиа вообще.
- Не включать (или оставить 0), если каждое медиа уникально — кеш будет только вытеснять сам себя, занимая RAM.
- На хосте с дефицитом RAM (профиль SGLang-KT в arriero, где CPU-память уходит под веса экспертов) учитывайте бюджет в хостовом резерве инстанса (`docs/RESOURCE_MANAGEMENT.md`).

## Влияние на производительность и память

- RAM хоста: ровно заданный бюджет в худшем случае (LRU вытесняет при превышении), плюс небольшой overhead на записи; in-flight-вычисления в бюджет не входят.
- VRAM: не затрагивается — CUDA-фичи не кешируются, что справка фиксирует явно.
- Latency: попадание убирает из TTFT скачивание, декодирование и препроцессинг медиа; single-flight дополнительно схлопывает конкурентные одинаковые загрузки в одну.
- CPU: промах платит один раз хешированием содержимого; на фоне декодирования это незаметно.

## Взаимодействие с другими аргументами

- `--tokenizer-worker-num`: делитель бюджета; кеши воркеров независимы, и попадание случается только в том воркере, куда запрос попал повторно.
- `--trust-mm-content-hashes`: режим выдачи по хешу клиента без чтения медиа; без кеша быстрый путь не работает.
- `--enable-mm-global-cache`: следующий слой — кеш готовых эмбеддингов энкодера (EPD-развертывание, Mooncake); слои независимы и складываются.
- `--enable-prefix-mm-cache`: кеширование на уровне префиксов запроса; тоже другой слой.
- `--mm-process-config` / `--image-processor-backend`: их значения входят в отпечаток процессора — смена настроек делает старые записи недостижимыми, а не отдает их по ошибке.

## Типовые проблемы и диагностика

- `ValueError: mm_preprocess_cache_size_mb must be non-negative` на старте — отрицательное значение.
- Задали бюджет, а строки `Multimodal preprocess cache enabled …` в логе нет — доля на воркер получилась нулевой (бюджет меньше `--tokenizer-worker-num`) либо значение 0.
- Повторные медиа не ускоряются при включенном кеше — проверьте, что запросы попадают в тот же tokenizer-воркер, что медиа действительно бинарно идентичны (другой ресайз на клиенте — другой хеш) и что записей меньше лимита 8192.
- Рост RSS tokenizer-процессов после включения — ожидаемый: это и есть кеш; суммарный потолок равен заданному бюджету.
- Итоговое значение поля видно в дампе `server_args=`; факт включения и раскладку по воркерам — в строке `Multimodal preprocess cache enabled …`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-preprocess-cache-size-mb 512
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3 --mm-preprocess-cache-size-mb 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/cache/preprocess_cache.py`
- `sglang/python/sglang/srt/multimodal/cache/identity.py`
- `sglang/python/sglang/srt/multimodal/media_artifacts/base.py`
- `sglang/python/sglang/srt/multimodal/processors/kimi_k3.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- upstream PR: sgl-project/sglang#34398 ([VLM] add content-addressed preprocessing cache infrastructure)
- arriero: `docs/RESOURCE_MANAGEMENT.md`
