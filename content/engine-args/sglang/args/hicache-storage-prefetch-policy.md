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
- Эффективное значение: из CLI не переопределяется; может быть изменено в рантайме через `PUT /hicache/storage-backend`. Отдельно отметим `UnifiedRadixCache`: его поле `prefetch_stop_policy` инициализируется значением `best_effort` и перезаписывается значением из `ServerArgs` в `init_hicache`
- Где объявлен: `ServerArgs.hicache_storage_prefetch_policy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация дерева кеша → проверка `can_terminate_prefetch` на каждом шаге планировщика для каждой активной операции предзагрузки

## Что меняет в движке

Значение попадает в `HiRadixCache.prefetch_stop_policy` (и в аналогичное поле `UnifiedRadixCache`) и читается единственной функцией `can_terminate_prefetch`:

- `best_effort` — возвращает «можно завершать» немедленно, не глядя на прогресс;
- `wait_complete` — только когда `operation.completed_tokens == len(operation.hash_value) * page_size`, то есть предзагружено все запрошенное;
- `timeout` — когда операция завершена **или** истек линейный тайм-аут `_prefetch_timeout_check_linear_func`:

```python
timeout = min(cfg.max, cfg.base + cfg.per_ki_token * num_tokens / 1024)
```

Параметры `cfg` берутся из `--hicache-storage-backend-extra-config` (`prefetch_timeout_base` = 2.0 с, `prefetch_timeout_per_ki_token` = 0.1 с на 1024 токена, `prefetch_timeout_max` = 30.0 с).

Дальше решение согласуется между rank'ами: состояния `(can_terminate, operation_terminated)` проходят `all_reduce(MAX)` по attention-группам, так что операция завершается либо когда условие выполнено на **всех** rank'ах, либо когда она уже завершена хотя бы на одном.

Если предзагрузка остановлена до того, как host-память была зафиксирована (типично для `best_effort` и для `timeout` на середине), `check_prefetch_progress` посылает воркеру сигнал остановки и отзывает операцию; иначе фактически полученный префикс усекается до минимума по rank'ам и вставляется в дерево.

Неизвестное значение политики в `can_terminate_prefetch` трактуется как «завершать» — но через CLI такое значение не пройдет, argparse ограничен списком.

## Значения и формат

- `timeout` (по умолчанию) — рекомендуемый апстримом вариант для продакшена: бюджет ожидания растет линейно с объемом предзагрузки и ограничен сверху.
- `wait_complete` — ждать полностью. Дает максимальный hit rate и используется в апстрим-примерах развертывания с `hf3fs`.
- `best_effort` — не ждать; берется то, что успело приехать. Для сценариев, крайне чувствительных к TTFT.
- Значение вне списка отвергает argparse.
- Настроить сам тайм-аут этим аргументом нельзя — только через `--hicache-storage-backend-extra-config`.

## Когда использовать

- `timeout` — умолчание, оставляйте его, пока нет измеренного SLO-конфликта. Подгонять стоит не политику, а три параметра тайм-аута.
- `wait_complete` — когда L3 быстрый (RDMA, локальный 3FS) и цена повторного prefill выше цены ожидания; типично для длинных общих префиксов.
- `best_effort` — когда L3 медленный или нестабильный, а хвост TTFT критичен; фактически превращает L3 в «бонус, если успел».
- Не выбирайте `wait_complete` при `file`-backend'е на обычном диске: ожидание может стоить больше, чем повторный prefill.

## Влияние на производительность и память

- TTFT: `wait_complete` дает самый длинный хвост, `best_effort` — самый короткий, `timeout` ограничивает хвост сверху.
- Hit rate L2/L3: обратный порядок.
- RAM: политика не меняет размер host-пула, но при `wait_complete` дольше удерживаются слоты под незавершенную предзагрузку; общий бюджет спекулятивного prefetch в `HiCacheController` ограничен половиной host-пула.
- Throughput под конкурентной нагрузкой: `wait_complete` удерживает запрос в очереди дольше, что при высокой конкуренции снижает общую пропускную способность.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--hicache-storage-backend`: без него предзагрузки нет и политика не работает.
- `--hicache-storage-backend-extra-config`: задает `prefetch_threshold` (когда предзагрузка вообще стартует) и три параметра тайм-аута для политики `timeout`.
- `--page-size`: реальный порог предзагрузки — `max(prefetch_threshold, page_size)`, а завершенность считается в страницах.
- `--enable-hierarchical-cache`: обязателен.
- `--tp-size` / DP-attention: решение о завершении согласуется между rank'ами через `all_reduce`, то есть самый медленный rank определяет общий результат при `wait_complete`.

## Типовые проблемы и диагностика

- Высокий и «рваный» TTFT после подключения L3 — типичная картина `wait_complete` с медленным хранилищем; начните с `timeout` и подберите `prefetch_timeout_*`.
- L3 подключен, а hit rate почти нулевой — вероятно, `best_effort` не успевает: проверьте политику и увеличьте `prefetch_threshold`, чтобы не запускать заведомо бесполезные мелкие предзагрузки.
- Строка «Prefetch <req_id> completed with N tokens» (уровень debug) показывает, сколько реально доехало.
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

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/hicache_storage.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
