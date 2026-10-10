---
schema: 1
engine: sglang
primaryName: "--enable-prefix-mm-cache"
title: "--enable-prefix-mm-cache"
summary: Локальный кеш эмбеддингов энкодера в памяти хоста, доступный только в режиме `--encoder-only`. Ключ — комбинированный хеш всего набора элементов запроса, поэтому попадание требует точного совпадения набора, а не общего префикса.
group: mm
related:
  - --encoder-only
  - --enable-mm-global-cache
  - --encoder-transfer-backend
  - --enable-metrics
  - --language-only
---

# --enable-prefix-mm-cache

## Кратко

`--enable-prefix-mm-cache` включает на encoder-сервере L1-кеш готовых эмбеддингов ViT в RAM хоста. Он проверяется до прогона энкодера и при попадании отдает сохраненный тензор. Ограничений два, и оба существенные: аргумент **требует** `--encoder-only` (иначе старт падает), а ключом служит комбинированный хеш **всего набора** мультимодальных элементов запроса — по отдельным элементам просмотра нет, несмотря на слово «prefix» в названии. Кроме того, кеш молча не используется вместе с `--enable-mm-global-cache` и с `--encoder-transfer-backend mooncake`.

## Оригинальная справка

```text
Enable prefix multimodal cache. Currently only supports mm-only.
```

## Паспорт аргумента

- Флаги: `--enable-prefix-mm-cache`
- Группа: `mm`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `false`
- Эффективное значение: ни один шаг резолва его не декларирует; в шаге `handle_encoder_disaggregation` только проверяется совместимость с `--encoder-only`
- Где объявлен: `python/sglang/srt/arg_groups/fields/mm.py:Mm.enable_prefix_mm_cache`
- Статус: обычный; ограничение «только mm-only» зафиксировано и в справке, и в проверке
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_encoder_disaggregation` (`arg_groups/pd_disaggregation_hook.py`, валидация) → каждый вызов `MMEncoder._compute_direct_embedding` в encoder-воркере (`disaggregation/encoder/server.py`)

## Что меняет в движке

Проверка на старте (`sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`, `handle_encoder_disaggregation`):

```python
if cfg.enable_prefix_mm_cache and not cfg.encoder_only:
    raise ValueError("--enable-prefix-mm-cache requires --encoder-only to be enabled")
```

Сам кеш — `MultiModalStaticCache` (`sglang/python/sglang/srt/mem_cache/multimodal_cache.py`), создаваемый в конструкторе `MMEncoder` (`sglang/python/sglang/srt/disaggregation/encoder/server.py`) **всегда**, независимо от флага; флаг решает, будет ли он использоваться. Размер задается переменной окружения, читаемой напрямую: `int(os.environ.get("SGLANG_VLM_CACHE_SIZE_MB", "4096"))`, то есть **4 ГиБ по умолчанию именно в encode-сервере** (в реестре `environ.py` у той же переменной значение по умолчанию 100, и оно применяется к другому, VRAM-кешу в scheduler'е).

Путь запроса в `_compute_direct_embedding`:

1. Каждому элементу проставляется `pad_value` и вычисляется контентный хеш (`resolve_multimodal_item_hash` → `hash_feature` — SHA-256 по байтам тензора, обрезанный до 8 байт). При `SGLANG_MM_SKIP_COMPUTE_HASH=1` хеш случайный, и попаданий не будет.
2. Хеши элементов сворачиваются в один ключ: `MultiModalStaticCache.combine_hashes(item_hashes)` = `hash(tuple(...))`.
3. `mm_cache.get(item_hashes)` ищет **только** по этому комбинированному ключу — в коде класса отдельно отмечено, что отката к поиску по отдельным элементам нет.
4. Промах ⇒ прогон ViT, результат переносится на CPU (`mm_embedding.cpu()`) и кладется в кеш.
5. Вставка вытесняет по LRU, пока не освободится место под новый тензор; если кеш пуст, а элемент всё равно не влезает, `set` возвращает `False` и запись просто не происходит.
6. Если эмбеддинг, взятый из кеша, не проходит проверку числа токенов, запись удаляется (`mm_cache.free`), чтобы битый результат не отравлял следующие запросы.

Кеш консультируется не на каждом вызове. Условие — `use_mm_cache = enable_prefix_mm_cache and not ctx.is_health_check and not keep_on_gpu and len(ctx.items_per_req) == 1`, и в этот путь запрос вообще попадает, только если глобальный кеш выключен:

- health-check запросы кеш обходят;
- `keep_on_gpu` истинно при `--encoder-transfer-backend mooncake`: эмбеддинг остается на GPU, и prefix-кеш не используется совсем;
- `EncoderScheduler` (`disaggregation/encoder/runtime.py`) сливает одновременно пришедшие запросы изображений или аудио в один батч, до `SGLANG_ENCODER_MAX_BATCH_SIZE` (по умолчанию 8). У слитого батча нет ключа на один запрос, и кеш для него пропускается. Видео не сливается;
- при `--enable-mm-global-cache` запрос идет путем глобального кеша (`_compute_global_cache_embedding`), и этот L1 не опрашивается.

## Значения и формат

- Флаг без значения.
- Размер кеша аргументом не задается — только `SGLANG_VLM_CACHE_SIZE_MB` (в МиБ) в окружении encoder-сервера.
- Единица учета внутри кеша — байты тензора эмбеддинга (`element_size * numel`), а не число запросов.
- Слово «prefix» в имени не означает частичного совпадения: попадание требует того же набора элементов в том же порядке.

## Когда использовать

- Encoder-сервер обслуживает поток, где один и тот же набор изображений повторяется целиком: повторные вопросы к одному документу, ретраи, A/B-прогон одинаковых входов, батчи с общей системной картинкой.
- Нужен дешевый выигрыш без внешней инфраструктуры: в отличие от `--enable-mm-global-cache`, здесь не нужен Mooncake.
- Транспорт эмбеддингов — `zmq_to_scheduler` или `zmq_to_tokenizer`: с `--encoder-transfer-backend mooncake` кеш не работает.
- Нагрузка последовательная или с редкими одновременными запросами: под плотным параллельным потоком изображений запросы сливаются в батчи, которые кеш пропускает.
- **Не включайте** на обычном моносервере — старт упадет с `ValueError`, потому что нет `--encoder-only`.
- **Не рассчитывайте** на попадания, если наборы элементов разные, а общая только первая картинка: механизма частичного совпадения нет.

## Влияние на производительность и память

- **RAM хоста: до `SGLANG_VLM_CACHE_SIZE_MB` МиБ (4096 по умолчанию) на процесс encoder-воркера.** Память занимается постепенно, по мере наполнения, а не сразу.
- **Латентность.** Попадание убирает прогон ViT целиком — это основная часть времени работы encoder-сервера.
- **VRAM.** Не затрагивается: эмбеддинги хранятся на CPU. Отдельной копии D2H кеш не добавляет: при не-`mooncake` транспорте эмбеддинг и так переносится на хост.
- **CPU.** Флаг добавляет хеширование содержимого признаков (в этом пути энкодер без кеша его не считает) и поиск по словарю.

## Взаимодействие с другими аргументами

- `--encoder-only`: жесткое требование; без него старт падает.
- `--enable-mm-global-cache`: L2 поверх Mooncake, разделяемый между узлами. Вместе с этим кешем не работает: при включенном глобальном кеше все запросы, кроме health-check, идут его путем, а health-check prefix-кеш обходит и сам. В такой конфигурации prefix-кеш не опрашивается и не наполняется — выбирайте один из двух.
- `--encoder-transfer-backend`: при `mooncake` эмбеддинги остаются на GPU и prefix-кеш не используется; при `zmq_to_scheduler`/`zmq_to_tokenizer` работает.
- `--enable-metrics`: включает `EncoderMetricsCollector`, без которого статистика попаданий/вытеснений не публикуется, хотя сам кеш работает.
- `--language-only`, `--encoder-urls`: LM-половина развертывания; кеш там не создается.
- В arriero эти гигабайты относятся к host-пулу и должны быть учтены в memory draw инстанса (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `ValueError: --enable-prefix-mm-cache requires --encoder-only to be enabled` — флаг задан на обычном сервере.
- Попаданий нет вообще — проверьте, что не включены `--enable-mm-global-cache` и `--encoder-transfer-backend mooncake`: с ними prefix-кеш не опрашивается. Под параллельной нагрузкой часть запросов попадает в слитые батчи (`Dispatching batch of N … requests` с N больше 1), и их кеш тоже пропускает.
- Попаданий нет, хотя картинки «те же»: значит различается набор или порядок элементов, либо байты признаков отличаются (другое разрешение, другой `--mm-process-config`, другой JPEG того же изображения). Хеш считается по содержимому тензора признаков, а не по URL.
- RAM растет и упирается в потолок — это ожидаемое наполнение кеша; уменьшайте `SGLANG_VLM_CACHE_SIZE_MB`.
- Метрики попаданий пустые — не включен `--enable-metrics`; сам кеш при этом работает.
- Значение аргумента видно в дампе `server_args=` при старте encoder-сервера.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-prefix-mm-cache --enable-metrics --port 30000
```

```bash
SGLANG_VLM_CACHE_SIZE_MB=8192 python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-prefix-mm-cache --encoder-transfer-backend zmq_to_scheduler --port 30000
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/mm.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/disaggregation/encoder/server.py`
- `sglang/python/sglang/srt/disaggregation/encoder/runtime.py`
- `sglang/python/sglang/srt/multimodal/cache/identity.py`
- `sglang/python/sglang/srt/mem_cache/multimodal_cache.py`
- `sglang/python/sglang/srt/managers/mm_utils.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
