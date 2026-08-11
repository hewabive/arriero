---
schema: 1
engine: sglang
primaryName: "--hicache-write-policy"
title: "--hicache-write-policy"
summary: Определяет, когда KV уезжает из VRAM в host-пул HiCache: сразу при вставке, после второго попадания или только при вытеснении. Меняет и алгоритм вытеснения из L1.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-storage-backend
  - --hicache-ratio
  - --hicache-size
  - --optimistic-prefill-attempts
  - --disaggregation-mode
---

# --hicache-write-policy

## Кратко

`--hicache-write-policy` решает главный компромисс HiCache: платить трафиком PCIe за то, чтобы префикс гарантированно оказался в L2, или экономить трафик и рисковать потерять его при вытеснении. Побочный эффект, о котором легко забыть: политика выбирает не только момент записи, но и **алгоритм вытеснения из VRAM** — `write_back` использует отдельный путь со стейджингом, все остальные — простой проход по листьям. Аргумент читается только при `--enable-hierarchical-cache`.

## Оригинальная справка

```text
The write policy of hierarchical cache.
```

## Паспорт аргумента

- Флаги: `--hicache-write-policy`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `write_back`, `write_through`, `write_through_selective`
- Значение по умолчанию: `write_through`
- Эффективное значение: из CLI не переопределяется; может быть изменено в рантайме через `PUT /hicache/storage-backend` (поле `hicache_write_policy`), при этом внутренний порог `write_through_threshold` пересчитывается
- Где объявлен: `ServerArgs.hicache_write_policy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание `HiCacheController` при инициализации дерева кеша → каждая вставка узла и каждый проход вытеснения

## Что меняет в движке

Значение передается в `HiCacheController(write_policy=…)` и параллельно задает порог в `HiRadixCache`:

```python
self.write_through_threshold = 1 if server_args.hicache_write_policy == "write_through" else 2
```

Дальше работают два механизма.

**Запись из L1 в L2.** При вставке узла `HiRadixCache._inc_hit_count` увеличивает `node.hit_count` и, если узел еще не забэкаплен и `hit_count >= write_through_threshold`, вызывает `write_backup(node)` — асинхронную DMA-передачу в host-пул. Для `write_back` этот путь отключен целиком: `_inc_hit_count` возвращается сразу, а сама вставка даже не вызывает счетчик (`if self.cache_controller.write_policy != "write_back"`).

- `write_through` — порог 1, то есть запись при первой же вставке;
- `write_through_selective` — порог 2, то есть только после повторного обращения к узлу;
- `write_back` — записи по попаданиям нет вообще.

Инвариант write-through: узел бэкапится только если его родитель уже забэкаплен, иначе `write_backup` возвращает 0 — забэкапленные узлы обязаны образовывать непрерывный префикс от корня.

**Вытеснение из L1.** `HiRadixCache.evict` разветвляется по политике:

- `write_back` → `_evict_write_back`: забэкапленные листья просто «понижаются» (device-слоты освобождаются, host-копия остается), незабэкапленные пытаются доехать до хоста прямо в момент вытеснения (`write_backup(x, write_back=True)`), а если host-пул переполнен — поддерево сбрасывается без бэкапа с предупреждением в лог. В исходниках этот путь помечен комментарием «note this path will be deprecated in the future»;
- `write_through` / `write_through_selective` → `_evict_write_through`: ничего не стейджится на лету, забэкапленные узлы понижаются, незабэкапленные просто удаляются.

Если подключен L3 (`--hicache-storage-backend`), запись в хранилище идет следом за подтверждением записи в L2: `_finish_write_through_ack` вызывает `write_backup_storage`. То есть политика управляет и попаданием данных в L3.

## Значения и формат

- `write_through` (по умолчанию) — «каждое обращение сразу пишется на следующий уровень». Максимальный hit rate, максимальный трафик хост↔GPU.
- `write_through_selective` — бэкапится только то, к чему обратились минимум дважды. Порог захардкожен (2) и через CLI не настраивается.
- `write_back` — данные уезжают на хост только в момент вытеснения из VRAM. Минимальный фоновый трафик, но при нехватке места в L2 часть KV теряется безвозвратно.
- Значение вне списка отвергает argparse.

## Когда использовать

- `write_through` — умолчание и правильный выбор, когда полоса PCIe не является узким местом, а префиксы переиспользуются часто.
- `write_through_selective` — когда write-through заметно съедает полосу (много уникальных запросов, из которых переиспользуется меньшинство): фильтр «второе попадание» отсекает одноразовые ветви.
- `write_back` — когда host-пул мал относительно device-пула и хочется максимально утилизировать L1, а также в единственном месте, где он обязателен: `--optimistic-prefill-attempts` на prefill-узле PD работает только с L2 и `write_back`.
- Не переключайтесь на `write_back` «для скорости»: он не ускоряет запись, он ее откладывает — и добавляет работу в критический путь вытеснения.

## Влияние на производительность и память

- Трафик PCIe и загрузка DMA: `write_through` > `write_through_selective` > `write_back`.
- Latency вытеснения: у `write_back` вытеснение может блокироваться на стейджинге в хост, у write-through путей — нет.
- Hit rate L2: `write_through` максимален, `write_through_selective` немного ниже на «одноразовых» префиксах, `write_back` ниже всех при дефиците host-пула.
- Объем RAM не зависит от политики — он задан `--hicache-ratio` / `--hicache-size`.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: без него значение не читается.
- `--hicache-ratio` / `--hicache-size`: при `write_back` маленький host-пул напрямую превращается в потерю KV при вытеснении, так что эта пара особенно важна.
- `--hicache-storage-backend`: запись в L3 инициируется после подтверждения записи в L2, то есть политика определяет, что вообще попадет в общее хранилище.
- `--optimistic-prefill-attempts`: при `--disaggregation-mode prefill` и включенном HiCache значение молча сбрасывается в 0 (с предупреждением «Optimistic prefill only supports L2 hierarchical cache with write-back policy»), если задан `--hicache-storage-backend` или политика не `write_back`.
- Рантайм-эндпоинт `PUT /hicache/storage-backend` принимает `hicache_write_policy` и меняет политику без перезапуска.

## Типовые проблемы и диагностика

- Предупреждение «write_back: KV cache on device are dropped without backup due to host memory pressure, subtree root …» — при `write_back` host-пул не смог принять вытесняемое поддерево, KV потерян. Увеличьте `--hicache-ratio`/`--hicache-size` или перейдите на write-through.
- «Optimistic prefill only supports L2 hierarchical cache with write-back policy» — оптимистичный prefill отключился из-за политики или из-за подключенного L3.
- Слишком высокая загрузка PCIe при низком hit rate — типичный признак того, что нужен `write_through_selective`.
- Текущую политику подтверждает дамп `server_args=` при старте; после рантайм-смены — строка «Set hicache_write_policy to …» в логе и ответ `GET /hicache/storage-backend`.
- Эффективность записи видна по счетчикам HiCache при `--enable-metrics` и по доле `cached_tokens` при `--enable-cache-report`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 3 --hicache-write-policy write_through_selective
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-size 80 --hicache-write-policy write_back
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_storage_runtime_attach_detach.mdx`
