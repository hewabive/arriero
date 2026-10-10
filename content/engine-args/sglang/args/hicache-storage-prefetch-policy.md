---
schema: 1
engine: sglang
primaryName: "--hicache-storage-prefetch-policy"
title: "--hicache-storage-prefetch-policy"
summary: Правило останова предзагрузки KV из L3 в host-пул: не ждать вовсе, ждать до конца или ждать до линейно растущего тайм-аута. Влияет только при подключенном `--hicache-storage-backend`.
group: memory
related:
  - --hicache-storage-backend
  - --hicache-storage-backend-extra-config
  - --enable-hierarchical-cache
  - --page-size
---

# --hicache-storage-prefetch-policy

## Кратко

Когда часть префикса не нашлась ни в VRAM, ни в host-пуле, HiCache запускает предзагрузку из L3. `--hicache-storage-prefetch-policy` отвечает на вопрос «сколько ждать эту загрузку, прежде чем начинать prefill тем, что уже есть». Это прямой обмен: `best_effort` минимизирует TTFT и теряет часть попаданий, `wait_complete` максимизирует hit rate и добавляет хвост latency, `timeout` (умолчание) — компромисс с настраиваемым бюджетом. Аргумент бессмысленен без `--hicache-storage-backend`: без L3 предзагружать неоткуда.

## Оригинальная справка

```text
Control when prefetching from the storage backend should stop.
```

## Паспорт аргумента

- Флаги: `--hicache-storage-prefetch-policy`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `best_effort`, `wait_complete`, `timeout`
- Значение по умолчанию: `timeout`
- Эффективное значение: из CLI не переопределяется; может быть изменено в рантайме через `PUT /hicache/storage-backend`. Поле `UnifiedRadixCache.prefetch_stop_policy` до подключения HiCache равно `best_effort` и перезаписывается значением аргумента в `init_hicache`
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.hicache_storage_prefetch_policy`
- Статус: обычный
- Этап применения: инициализация дерева кеша → проверка `can_terminate_prefetch` на каждом шаге планировщика для каждой активной операции предзагрузки

## Что меняет в движке

Отдельного `HiRadixCache` больше нет: значение попадает в `UnifiedRadixCache.prefetch_stop_policy` (`sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`). На каждом шаге планировщика `check_prefetch_progress` завершает операцию, если она уже закончилась сама (`operation.is_terminated()`), а иначе спрашивает `_can_terminate_prefetch`:

- `best_effort` — «можно завершать» немедленно, не глядя на прогресс;
- `wait_complete` — досрочно не завершает никогда: операция заканчивается только сама, когда поток синхронизации контроллера сведет подтверждения прогресса по rank'ам (по минимуму);
- `timeout` — когда истек линейный тайм-аут `_prefetch_timeout_check_linear_func`:

```python
elapsed > prefetch_timeout_base + len(operation.hash_value) * prefetch_timeout_per_page
prefetch_timeout_per_page = page_size / 1024 * prefetch_timeout_per_ki_token
```

То есть бюджет — `base + per_ki_token * (число страниц × page_size) / 1024`, **без верхнего потолка**. Оба параметра берутся из `--hicache-storage-backend-extra-config` (`prefetch_timeout_base` = 1.0 с, `prefetch_timeout_per_ki_token` = 0.25 с на 1024 токена; `StorageAttachment.apply_runtime_config` в `mem_cache/unified_cache/storage_attachment.py`). Апстрим-документация `hicache_design.mdx` все еще описывает умолчания 2 с / 0.1 с и ключ `prefetch_timeout_max` = 30 с, но код его не читает — прав код.

Решение для `timeout` согласуется между rank'ами: часы rank'ов расходятся, поэтому решает первая PP-стадия, внутри нее attention-группы TP/CP сводятся по `MAX` (достаточно, чтобы тайм-аут истек на одном rank'е), и вердикт рассылается по остальным PP-стадиям.

После решения `check_prefetch_progress` вызывает `terminate_prefetch`. Если host-слоты под операцию так и не были выделены, предзагрузка отзывается; иначе `_handle_prefetch_result` вставляет в дерево уже согласованный между rank'ами префикс `completed_tokens` как host-узлы, а недогруженный хвост host-слотов освобождает поток ввода-вывода контроллера.

Неизвестное значение политики в `_can_terminate_prefetch` трактуется как «завершать» — но через CLI такое значение не пройдет, argparse ограничен списком, а рантайм-эндпоинт проверяет его в `StorageAttachment._validate_policies`.

## Значения и формат

- `timeout` (по умолчанию) — рекомендуемый апстримом вариант для продакшена: бюджет ожидания растет линейно с объемом предзагрузки; верхнего потолка в коде нет.
- `wait_complete` — ждать полностью. Дает максимальный hit rate и используется в апстрим-примерах развертывания с `hf3fs`.
- `best_effort` — не ждать; берется то, что успело приехать. Для сценариев, крайне чувствительных к TTFT.
- Значение вне списка отвергает argparse.
- Настроить сам тайм-аут этим аргументом нельзя — только через `--hicache-storage-backend-extra-config`.

## Когда использовать

- `timeout` — умолчание, оставляйте его, пока нет измеренного SLO-конфликта. Подгонять стоит не политику, а два параметра тайм-аута; потолка нет, поэтому для очень длинных префиксов бюджет ожидания растет без ограничения.
- `wait_complete` — когда L3 быстрый (RDMA, локальный 3FS) и цена повторного prefill выше цены ожидания; типично для длинных общих префиксов.
- `best_effort` — когда L3 медленный или нестабильный, а хвост TTFT критичен; фактически превращает L3 в «бонус, если успел».
- Не выбирайте `wait_complete` при `file`-backend'е на обычном диске: ожидание может стоить больше, чем повторный prefill.

## Влияние на производительность и память

- TTFT: `wait_complete` дает самый длинный хвост, `best_effort` — самый короткий, `timeout` ограничивает хвост линейным бюджетом от объема предзагрузки.
- Hit rate L2/L3: обратный порядок.
- RAM: политика не меняет размер host-пула, но при `wait_complete` дольше удерживаются слоты под незавершенную предзагрузку; общий бюджет спекулятивного prefetch в `HiCacheController` ограничен половиной host-пула.
- Throughput под конкурентной нагрузкой: `wait_complete` удерживает запрос в очереди дольше, что при высокой конкуренции снижает общую пропускную способность.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--hicache-storage-backend`: без него предзагрузки нет и политика не работает.
- `--hicache-storage-backend-extra-config`: задает `prefetch_threshold` (когда предзагрузка вообще стартует) и два параметра тайм-аута для политики `timeout` (`prefetch_timeout_base`, `prefetch_timeout_per_ki_token`).
- `--page-size`: реальный порог предзагрузки — `max(prefetch_threshold, page_size)`, а завершенность считается в страницах.
- `--enable-hierarchical-cache`: обязателен.
- `--tp-size` / DP-attention: при `wait_complete` прогресс сводится по минимуму, то есть общий результат определяет самый медленный rank; при `timeout` достаточно истечения тайм-аута на одном rank'е первой PP-стадии.

## Типовые проблемы и диагностика

- Высокий и «рваный» TTFT после подключения L3 — типичная картина `wait_complete` с медленным хранилищем; начните с `timeout` и подберите `prefetch_timeout_*`.
- L3 подключен, а hit rate почти нулевой — вероятно, `best_effort` не успевает: проверьте политику и увеличьте `prefetch_threshold`, чтобы не запускать заведомо бесполезные мелкие предзагрузки.
- Строка «HiCache prefetch success req=<rid> completed=N matched=M loaded=L occupied=O» (уровень info; `dropped` вместо `success`, если вставка в дерево не удалась) показывает, сколько реально доехало и сколько из этого оказалось новым для дерева.
- Текущую политику подтверждает дамп `server_args=` при старте; после рантайм-смены — строка «Set hicache_storage_prefetch_policy to …» и ответ `GET /hicache/storage-backend`.
- Доля переиспользованных токенов видна при `--enable-cache-report` (`cached_tokens`) и в метриках хранилища при `--enable-metrics`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-storage-backend file --hicache-storage-prefetch-policy best_effort
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --page-size 64 --enable-hierarchical-cache --hicache-mem-layout page_first_direct --hicache-io-backend direct --hicache-storage-backend hf3fs --hicache-storage-prefetch-policy wait_complete
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/storage_attachment.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/hicache_storage.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
