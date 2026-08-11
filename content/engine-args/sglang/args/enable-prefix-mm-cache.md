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
  - --mm-global-cache-backend
  - --encoder-transfer-backend
  - --enable-metrics
  - --language-only
---

# --enable-prefix-mm-cache

## Кратко

`--enable-prefix-mm-cache` включает на encoder-сервере L1-кеш готовых эмбеддингов ViT в RAM хоста. Он проверяется до прогона энкодера и при попадании отдает сохраненный тензор. Ограничений два, и оба существенные: аргумент **требует** `--encoder-only` (иначе старт падает), а ключом служит комбинированный хеш **всего набора** мультимодальных элементов запроса — по отдельным элементам просмотра нет, несмотря на слово «prefix» в названии.

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
- Эффективное значение: не переопределяется; в `_handle_encoder_disaggregation` только проверяется совместимость с `--encoder-only`
- Где объявлен: `ServerArgs.enable_prefix_mm_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; ограничение «только mm-only» зафиксировано и в справке, и в проверке
- Этап применения: `__post_init__` (валидация) → каждый вызов `_encode` в encoder-воркере

## Что меняет в движке

Проверка на старте (`sglang/python/sglang/srt/server_args.py`):

```python
if self.enable_prefix_mm_cache and not self.encoder_only:
    raise ValueError("--enable-prefix-mm-cache requires --encoder-only to be enabled")
```

Сам кеш — `MultiModalStaticCache` (`sglang/python/sglang/srt/mem_cache/multimodal_cache.py`), создаваемый в encoder-воркере **всегда**, независимо от флага; флаг решает, будет ли он использоваться. Размер задается переменной окружения, читаемой напрямую: `int(os.environ.get("SGLANG_VLM_CACHE_SIZE_MB", "4096"))`, то есть **4 ГиБ по умолчанию именно в encode-сервере** (в реестре `environ.py` у той же переменной значение по умолчанию 100, и оно применяется к другому, VRAM-кешу в scheduler'е).

Путь запроса в `_encode`:

1. Каждому элементу проставляется `pad_value` и вычисляется контентный хеш (`hash_feature` — SHA-256 по байтам тензора, обрезанный до 8 байт).
2. Хеши элементов сворачиваются в один ключ: `MultiModalStaticCache.combine_hashes(item_hashes)` = `hash(tuple(...))`.
3. `mm_cache.get(item_hashes)` ищет **только** по этому комбинированному ключу — в коде класса отдельно отмечено, что отката к поиску по отдельным элементам нет.
4. Промах ⇒ прогон ViT, результат переносится на CPU (`mm_embedding.cpu()`) и кладется в кеш.
5. Вставка вытесняет по LRU, пока не освободится место под новый тензор; если кеш пуст, а элемент всё равно не влезает, `set` возвращает `False` и запись просто не происходит.

Кеш дополнительно выключается для запросов, помеченных как health-check: `use_mm_cache = get_mm().enable_prefix_mm_cache and log_metrics`, а `log_metrics` равен `not is_health_check_request(req_id)`.

## Значения и формат

- Флаг без значения.
- Размер кеша аргументом не задается — только `SGLANG_VLM_CACHE_SIZE_MB` (в МиБ) в окружении encoder-сервера.
- Единица учета внутри кеша — байты тензора эмбеддинга (`element_size * numel`), а не число запросов.
- Слово «prefix» в имени не означает частичного совпадения: попадание требует того же набора элементов в том же порядке.

## Когда использовать

- Encoder-сервер обслуживает поток, где один и тот же набор изображений повторяется целиком: повторные вопросы к одному документу, ретраи, A/B-прогон одинаковых входов, батчи с общей системной картинкой.
- Нужен дешевый выигрыш без внешней инфраструктуры: в отличие от `--enable-mm-global-cache`, здесь не нужен Mooncake.
- **Не включайте** на обычном моносервере — старт упадет с `ValueError`, потому что нет `--encoder-only`.
- **Не рассчитывайте** на попадания, если наборы элементов разные, а общая только первая картинка: механизма частичного совпадения нет.

## Влияние на производительность и память

- **RAM хоста: до `SGLANG_VLM_CACHE_SIZE_MB` МиБ (4096 по умолчанию) на процесс encoder-воркера.** Память занимается постепенно, по мере наполнения, а не сразу.
- **Латентность.** Попадание убирает прогон ViT целиком — это основная часть времени работы encoder-сервера.
- **VRAM.** Не затрагивается: эмбеддинги хранятся на CPU. Плата — копия D2H на каждой вставке.
- **CPU.** Хеширование содержимого признаков делается всегда (оно нужно для `pad_value`), так что флаг добавляет только поиск по словарю и копию на CPU.

## Взаимодействие с другими аргументами

- `--encoder-only`: жесткое требование; без него старт падает.
- `--enable-mm-global-cache`: L2 поверх Mooncake, разделяемый между узлами. Дополняет этот кеш, а не заменяет: локальный дешевле и быстрее, глобальный переживает перезапуск и виден другим экземплярам.
- `--mm-global-cache-backend`: относится к L2, не к этому кешу.
- `--encoder-transfer-backend`: транспорт выхода энкодера; на попадания не влияет.
- `--enable-metrics`: включает `EncoderMetricsCollector`, без которого статистика попаданий/вытеснений не публикуется, хотя сам кеш работает.
- `--language-only`, `--encoder-urls`: LM-половина развертывания; кеш там не создается.
- В arriero эти гигабайты относятся к host-пулу и должны быть учтены в memory draw инстанса (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `ValueError: --enable-prefix-mm-cache requires --encoder-only to be enabled` — флаг задан на обычном сервере.
- Попаданий нет, хотя картинки «те же»: значит различается набор или порядок элементов, либо байты признаков отличаются (другое разрешение, другой `--mm-process-config`, другой JPEG того же изображения). Хеш считается по содержимому тензора признаков, а не по URL.
- RAM растет и упирается в потолок — это ожидаемое наполнение кеша; уменьшайте `SGLANG_VLM_CACHE_SIZE_MB`.
- Метрики попаданий пустые — не включен `--enable-metrics`; сам кеш при этом работает.
- Значение аргумента видно в дампе `server_args=` при старте encoder-сервера.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-prefix-mm-cache --enable-metrics --port 30000
```

```bash
SGLANG_VLM_CACHE_SIZE_MB=8192 python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-prefix-mm-cache --enable-mm-global-cache --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/mem_cache/multimodal_cache.py`
- `sglang/python/sglang/srt/managers/mm_utils.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
