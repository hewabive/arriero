---
schema: 1
engine: sglang
primaryName: "--enable-mm-global-cache"
title: "--enable-mm-global-cache"
summary: Общий для нескольких узлов кеш эмбеддингов энкодера поверх Mooncake. Работает только на encoder-сервере EPD-развертывания и поднимает 4 ГиБ pinned host-памяти на ранг.
group: mm
related:
  - --mm-global-cache-backend
  - --encoder-only
  - --encoder-transfer-backend
  - --encoder-urls
  - --language-only
  - --enable-prefix-mm-cache
  - --tp-size
---

# --enable-mm-global-cache

## Кратко

`--enable-mm-global-cache` включает L2-кеш **готовых эмбеддингов** визуального/аудио энкодера, разделяемый между процессами и узлами через Mooncake. Ключ — контентный хеш мультимодального элемента, значение — уже посчитанный ViT-выход. При попадании ViT не запускается вообще. Флаг читается ровно в одном месте — в `encode_server.py`, то есть **только на encoder-сервере** EPD/энкодер-дезагрегированного развертывания. На обычном моносервере он не делает ничего.

## Оригинальная справка

```text
Enable global multimodal embedding cache to skip redundant ViT inference.
```

## Паспорт аргумента

- Флаги: `--enable-mm-global-cache`
- Группа: `mm`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; `__post_init__` не трогает это поле
- Где объявлен: `ServerArgs.enable_mm_global_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация encoder-воркера (`sglang/python/sglang/srt/disaggregation/encode_server.py`), затем каждый вызов энкодера

## Что меняет в движке

При включенном флаге encoder-воркер создает `EmbeddingCacheController` (`sglang/python/sglang/srt/mem_cache/embedding_cache_controller.py`) поверх backend'а, выбранного `--mm-global-cache-backend`. Контроллер:

- выделяет пул **закрепленной (pinned) host-памяти** размером 4 ГиБ на ранг (значение по умолчанию `max_pool_size_gb=4.0`, encode-сервер его не переопределяет), деля его в пропорции 80/20 между vision- и audio-пулом (`VISION_POOL_RATIO = 0.8`);
- нарезает пулы на страницы с целевым размером 256 КиБ и раздает их range-аллокатором, предпочитающим непрерывные пробеги страниц;
- поднимает фоновый IO-поток, очереди prefetch/insert и LRU-вытеснение внутри пула;
- при `--tp-size > 1` создает отдельную gloo-группу для согласования prefetch между рангами.

Путь запроса на энкодере: ранг 0 считает контентные хеши элементов и приводит их к строкам (`str_mm_hashes`) → `batch_is_exist` спрашивает Mooncake, какие из них уже есть → попадания префетчатся в host-пул и грузятся на устройство асинхронно (`load_to_device_async`) → промахи считаются ViT'ом обычным путем и в фоне укладываются в пул и в Mooncake (`store_to_pool_async`, `insert_batch`). Ключ в хранилище формируется как `emb_<hash>` (`EmbeddingStore.get_key`).

Важно понимать соседей:

- **`--encoder-transfer-backend mooncake`** — это другое: он отвечает только за то, как выход энкодера доезжает до LM-сервера. Глобальный кеш работает независимо от выбранного transfer-backend'а.
- **`--enable-prefix-mm-cache`** — локальный L1-кеш эмбеддингов в том же процессе энкодера. Он и глобальный кеш не заменяют друг друга.
- Во **всех** развертываниях (не только EPD) уже работает локальный кеш эмбеддингов в процессе scheduler'а — `MultiModalStaticCache`, размер которого задает `SGLANG_VLM_CACHE_SIZE_MB` (100 МиБ по умолчанию, VRAM). Он не связан с этим флагом.

## Значения и формат

- Флаг без значения; выключить можно только не передавая его.
- Размер host-пула этим аргументом не задается — он зашит в конструкторе контроллера.
- Никакой валидации «а Mooncake вообще настроен?» на этапе разбора аргументов нет: ошибка придет позже, при импорте и инициализации backend'а.

## Когда использовать

- EPD-развертывание с несколькими encoder-серверами, где один и тот же контент (страницы документов, кадры, логотипы, системная картинка в шаблоне) приходит в разные запросы и на разные экземпляры. ViT-прогон — самая дорогая часть мультимодального prefill, и попадание его убирает целиком.
- Mooncake уже развернут для других задач (HiCache), метаданные и мастер доступны.
- **Не включайте** на одиночном моносервере: флаг читается только в `encode_server.py` и там ничего не изменит.
- **Не включайте**, если контент почти всегда уникален: попаданий не будет, а 4 ГиБ pinned RAM на ранг и фоновый IO-поток останутся.

## Влияние на производительность и память

- **RAM хоста: 4 ГиБ pinned на ранг.** Закрепленная память не свопится и не отдается системе — на 4-ранговом энкодере это 16 ГиБ, отнятых у хоста безусловно.
- **Сеть.** Каждый промах добавляет запись в Mooncake, каждое попадание — чтение; на RDMA-транспорте это дешево, на TCP — заметно.
- **Латентность.** Попадание убирает прогон ViT целиком, то есть срезает основную часть TTFT мультимодального запроса. Промах добавляет к обычному пути только асинхронные `batch_is_exist` и фоновую запись.
- **VRAM.** Пул кеша живет на хосте; на устройство эмбеддинги копируются по мере надобности асинхронными копиями.
- **Время старта.** Аллокация и `cudaHostRegister` 4 ГиБ pinned-региона не бесплатны.

## Взаимодействие с другими аргументами

- `--mm-global-cache-backend`: какой класс `EmbeddingStore` создать; сегодня в `choices` только `mooncake`.
- `--encoder-only`: развертывание, в котором единственно и работает этот флаг.
- `--encoder-transfer-backend`: ортогонален — про транспорт выхода энкодера, а не про кеш.
- `--enable-prefix-mm-cache`: локальный L1 на том же энкодере; его размер задает `SGLANG_VLM_CACHE_SIZE_MB` (в encode-сервере читается напрямую из окружения со значением по умолчанию 4096 МиБ).
- `--tp-size`: пул создается на каждый ранг, и при TP > 1 поднимается дополнительная gloo-группа для согласования префетча.
- `--language-only`, `--encoder-urls`: вторая половина EPD-развертывания; кеш на них не создается.
- В arriero эти 4 ГиБ на ранг относятся к host-пулу и должны попасть в memory draw инстанса (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `ImportError: Failed to import embedding store backend 'mooncake' ...` — пакет Mooncake не установлен в окружении.
- Ошибки подключения при старте энкодера — не выставлены `MOONCAKE_TE_META_DATA_SERVER` / `MOONCAKE_MASTER` / `MOONCAKE_PROTOCOL` / `MOONCAKE_GLOBAL_SEGMENT_SIZE`.
- Флаг задан, а поведение не изменилось — сервер поднят без `--encoder-only`: код чтения флага живет только в encode-сервере.
- Хост неожиданно потерял несколько гигабайт «навсегда» — это pinned-пул контроллера.
- Подтверждение создания backend'а в логе: `Creating embedding store backend 'mooncake' (sglang.srt.mem_cache.storage.mooncake_store.mooncake_embedding_store.MooncakeEmbeddingStore)`. Значение аргумента видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-mm-global-cache --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-mm-global-cache --mm-global-cache-backend mooncake --encoder-transfer-backend mooncake --tp-size 2 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/mem_cache/embedding_cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/embedding_store.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
