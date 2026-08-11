---
schema: 1
engine: sglang
primaryName: "--mm-global-cache-backend"
title: "--mm-global-cache-backend"
summary: Имя backend'а хранилища для глобального кеша эмбеддингов энкодера. Сегодня в списке одно значение — `mooncake`; аргумент существует ради точки расширения `EmbeddingStoreFactory`.
group: mm
related:
  - --enable-mm-global-cache
  - --encoder-only
  - --encoder-transfer-backend
  - --enable-prefix-mm-cache
---

# --mm-global-cache-backend

## Кратко

`--mm-global-cache-backend` выбирает класс `EmbeddingStore`, поверх которого работает глобальный кеш эмбеддингов. Значение читается только когда задан `--enable-mm-global-cache`, то есть только на encoder-сервере. Допустимое значение сегодня одно — `mooncake`, и оно же стоит по умолчанию, поэтому явно задавать аргумент почти никогда не нужно.

## Оригинальная справка

```text
Storage backend for the multimodal global embedding cache. Used when --enable-mm-global-cache is set.
```

## Паспорт аргумента

- Флаги: `--mm-global-cache-backend`
- Группа: `mm`
- Тип значения: строка
- Допустимые значения: `mooncake` — единственный элемент `choices`; при этом сам реестр `EmbeddingStoreFactory` расширяем во время выполнения через `register_backend`, а argparse об этом не знает
- Значение по умолчанию: `mooncake`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.mm_global_cache_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация encoder-воркера, в момент создания `EmbeddingCacheController`

## Что меняет в движке

Значение уходит в `EmbeddingStoreFactory.create_backend(...)` (`sglang/python/sglang/srt/mem_cache/embedding_store.py`), который по имени достает из реестра пару «модуль, класс», лениво импортирует её и проверяет, что класс наследует `EmbeddingStore`. Единственная штатная регистрация в дереве:

```python
EmbeddingStoreFactory.register_backend(
    "mooncake",
    "sglang.srt.mem_cache.storage.mooncake_store.mooncake_embedding_store",
    "MooncakeEmbeddingStore",
)
```

Backend отвечает только за внешнее хранилище: `batch_get`/`batch_put` по указателям и размерам, `batch_is_exist` для проверки попаданий, и ключ вида `emb_<hash>`. Всё остальное — host-пул на 4 ГиБ, страничный аллокатор, LRU, фоновый IO-поток — живет в `EmbeddingCacheController` и от выбора backend'а не зависит.

Регистрация новых backend'ов возможна из кода (`EmbeddingStoreFactory.register_backend(...)` до запуска), но передать их имя через CLI не получится: `choices` установленной сборки его отвергнет. Это тот же класс расхождений между декларацией и рантаймом, который описан в `docs/CASE_PHANTOM_HELP_ARGS.md`.

## Значения и формат

- Одна строка. Отличное от `mooncake` значение argparse отвергнет: `invalid choice`.
- Неизвестное имя, дошедшее до фабрики иным путем, дает `ValueError: Unknown embedding store backend '<name>'. Registered backends: ['mooncake'].`
- Значение читается **только** при `--enable-mm-global-cache`; без него аргумент инертен.

## Когда использовать

- Практически никогда: значение по умолчанию совпадает с единственным допустимым. Задавайте явно, если хотите зафиксировать выбор в командной строке ради читаемости конфигурации развертывания.
- Проверьте `python -m sglang.launch_server --help` своей сборки, прежде чем рассчитывать на другое значение: список `choices` может отличаться от того, что в исходниках upstream-checkout'а.

## Влияние на производительность и память

- Сам выбор ничего не выделяет: пул и потоки создает контроллер кеша, а не backend.
- Пропускная способность и латентность глобального кеша целиком определяются настройкой Mooncake (`MOONCAKE_PROTOCOL`, размер сегмента, RDMA против TCP), а не этим аргументом.

## Взаимодействие с другими аргументами

- `--enable-mm-global-cache`: без него значение не читается вообще.
- `--encoder-transfer-backend`: тоже принимает значение `mooncake`, но отвечает за транспорт выхода энкодера к LM-серверу. Совпадение имен — единственное, что их связывает; настраиваются они независимо.
- `--enable-prefix-mm-cache`: локальный L1-кеш эмбеддингов в том же процессе; backend'а не имеет.

## Типовые проблемы и диагностика

- `argument --mm-global-cache-backend: invalid choice: '...'` — значение вне списка установленной сборки.
- `ImportError: Failed to import embedding store backend 'mooncake' from 'sglang.srt.mem_cache.storage.mooncake_store.mooncake_embedding_store'` — пакет Mooncake не установлен в окружении сервера.
- `TypeError: Backend class ... must inherit from EmbeddingStore` — самостоятельно зарегистрированный backend не реализует контракт.
- Подтверждение выбора в логе энкодера: `Creating embedding store backend 'mooncake' (<module>.<class>)`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-mm-global-cache --mm-global-cache-backend mooncake --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --encoder-only --enable-mm-global-cache --mm-global-cache-backend mooncake --encoder-transfer-backend zmq_to_scheduler --port 30001
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/embedding_store.py`
- `sglang/python/sglang/srt/mem_cache/embedding_cache_controller.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
- arriero: `docs/CASE_PHANTOM_HELP_ARGS.md`
