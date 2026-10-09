---
schema: 1
engine: vllm
primaryName: "--enable-mamba-shared-prefix-checkpoint"
title: "--enable-mamba-shared-prefix-checkpoint"
summary: Для гибридных Mamba-моделей со спекулятивным EAGLE/MTP дополнительно сохраняет состояние Mamba в точке, где кончается общий с другими запросами префикс, чтобы следующие запросы с тем же префиксом попадали в prefix cache внутри Mamba-блока. Вне узкого набора условий молча ничего не делает.
group: CacheConfig
related:
  - --mamba-cache-mode
  - --prefix-match-unit
  - --mamba-block-size
  - --enable-prefix-caching
  - --speculative-config
  - --block-size
---

# --enable-mamba-shared-prefix-checkpoint

## Кратко

В режиме `--mamba-cache-mode align` состояние Mamba кэшируется только на сетке Mamba-блоков и в хвосте промпта, поэтому попадание в prefix cache для Mamba-группы может «приземлиться» лишь там. Флаг добавляет ещё одну точку сохранения — стык общего префикса (shared-prefix junction): позицию, до которой более ранний запрос с тем же префиксом уже был закэширован другой группой KV-cache. Запросы, у которых общий префикс кончается внутри блока (длинный системный промпт, дальше расхождение), получают возможность продолжить с этой точки, а не пересчитывать хвост блока.

Флаг — переименование `--enable-mamba-fine-grained-prefix-cache` (upstream-коммит `49ee12d74`, #57382): поле, справка и поведение те же, старого имени-алиаса не оставлено.

## Оригинальная справка

```text
Also register a Mamba "align" checkpoint at the shared-prefix junction --
where an EAGLE/MTP sibling was observed to resume -- instead of only at the
prompt tail. Off by default; only takes effect with `mamba_cache_mode`
"align", EAGLE on the Mamba group, and a prefix match unit smaller than the
Mamba block size.
```

## Паспорт аргумента

- Флаги: `--enable-mamba-shared-prefix-checkpoint`, `--no-enable-mamba-shared-prefix-checkpoint`
- Группа argparse: `CacheConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-` форма ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: включается, только если одновременно выполнено всё ниже; иначе молча остаётся выключенным, без строки в логе. `KVCacheManager` требует непустой набор EAGLE-групп KV-cache (`coordinator.eagle_group_ids`), включённые частичные попадания по хешу (`coordinator.enable_partial_hash_hits`) и отсутствие хвоста повторного prefill (`num_reprefillable_tokens == 0`, то есть не multi-module MTP). Планировщик дополнительно требует `mamba_partial_cache_hit`: block-aligned разрез для Mamba и `hash_block_size` (`--prefix-match-unit`) меньше размера блока планировщика
- Где объявлен: `vllm/config/cache.py:CacheConfig.enable_mamba_shared_prefix_checkpoint`
- Этап применения: создание `KVCacheManager` и `Scheduler` в engine core → поиск попаданий в prefix cache и разрез prefill на куски на каждом шаге

## Что меняет в движке

**Где берётся стык.** `KVCacheManager.get_computed_blocks` при поиске попадания возвращает, кроме самих блоков, `shared_prefix_boundary` — позицию, до которой самая «длинная» группа KV-cache (обычно attention) нашла закэшированный префикс, тогда как отстающая разреженная группа (Mamba или sliding window) закэширована короче. Планировщик сохраняет её в `request.shared_prefix_boundary`. Без флага эта позиция используется только для удержания блоков и округляется вниз до границы блока.

**Что добавляет флаг.** В `_mamba_block_aligned_split` (`vllm/v1/core/sched/scheduler.py`) появляется ещё одна обязательная точка остановки куска — ровно на стыке, если он внутри промпта; за пределами промпта остаётся округлённая до блока точка. Кусок prefill заканчивается на стыке, и `MambaManager` (`single_type_kv_cache_manager.py`), у которого выставлен `shared_prefix_checkpoint`, регистрирует частичный блок состояния не только на последней хеш-границе промпта, но и при `num_tokens == request.shared_prefix_boundary`. Следующий запрос с тем же префиксом находит в prefix cache и это состояние.

**Почему условия жёсткие.** Комментарий в `KVCacheManager` прямо говорит, что предикат один на планировщик и менеджер: иначе планировщик резал бы кусок на стыке, который менеджер откажется сохранить, — это лишний forward и сдвинутая точка остановки на границе блока. Multi-module MTP исключён, потому что тогда `cache_blocks` передаёт менеджеру не конец куска, а `num_computed - num_reprefillable`.

## Значения и формат

- Голый флаг включает, `--no-enable-mamba-shared-prefix-checkpoint` явно выключает; не задан — выключено.
- Старое имя `--enable-mamba-fine-grained-prefix-cache` больше не разбирается: argparse завершит запуск с `unrecognized arguments`. Совместимого алиаса нет.
- Поле перечислено в `ignored_factors` `CacheConfig.compute_hash`, поэтому переключение не инвалидирует кэш компиляции.

## Когда использовать

- Гибридная модель (attention-слои вперемешку с Mamba-слоями) с EAGLE/MTP на Mamba-группе, prefix caching в режиме `align`, и трафик, где много запросов разделяют длинный префикс, после которого расходятся. Именно этот сценарий описан в `docs/features/automatic_prefix_caching.md` апстрима.
- Обязательно вместе с явным `--prefix-match-unit`, меньшим размера Mamba-блока: без него шаг хеширования в `align` равен блоку, точек внутри блока нет, и флаг ни на что не влияет. Апстрим предлагает начинать с `64`.
- Не включайте на обычной трансформерной модели, на гибридной без спекулятивного декодирования и при multi-module MTP: эффекта не будет, а ошибки тоже не будет — легко принять за работающую оптимизацию.

## Влияние на производительность и память

- **TTFT при общем префиксе.** Главный выигрыш: запрос с тем же префиксом продолжает со стыка, а не с предыдущей границы Mamba-блока, и не пересчитывает до блока токенов prefill.
- **Шаги prefill.** Первый запрос, проходящий через стык, получает дополнительную точку остановки, то есть его prefill режется на один кусок больше.
- **KV-cache.** Отдельной памяти на старте не выделяется. Сохранённое на стыке состояние занимает блок Mamba-группы из общего пула KV-cache и конкурирует за место в prefix cache с остальными закэшированными блоками; блок состояния Mamba крупный, поэтому лишние точки ускоряют вытеснение.
- **Время старта и VRAM весов.** Не влияет.

## Взаимодействие с другими аргументами

- `--mamba-cache-mode`: требуется `align`; в режимах `none` и `all` частичных попаданий для Mamba нет.
- `--prefix-match-unit`: должен быть меньше Mamba-блока и делить размеры блоков всех групп; это источник `hash_block_size < block_size`.
- `--mamba-block-size`: задаёт сетку, внутри которой появляется дополнительная точка.
- `--enable-prefix-caching`: без prefix caching поиска попаданий нет, и стыку неоткуда взяться.
- `--speculative-config`: нужен EAGLE-подобный драфтер (EAGLE, EAGLE3, MTP). Multi-module MTP — `method: mtp`, когда и `num_speculative_tokens`, и число MTP-слоёв модели (`num_nextn_predict_layers`) больше 1 — даёт `num_prefill_lookahead_tokens > 1` и отключает механизм.
- `--block-size`: размер блока attention-групп, участвует в проверке делимости `--prefix-match-unit`.

## Типовые проблемы и диагностика

- **Симптом:** `error: unrecognized arguments: --enable-mamba-fine-grained-prefix-cache` после обновления vLLM. **Причина:** переименование. **Лечение:** заменить на `--enable-mamba-shared-prefix-checkpoint`; какое имя принимает установленная версия, показывает `vllm serve --help=enable-mamba`.
- **Симптом:** флаг включён, попаданий в prefix cache не прибавилось. **Причина:** не выполнено одно из условий — чаще всего не задан `--prefix-match-unit` или нет EAGLE/MTP. **Проверка:** в логе не должно быть `Disabling fine-grained prefix-cache hits because these KV cache managers require block-aligned lookups: ...` — это предупреждение выключает частичные попадания целиком; долю попаданий смотреть в `/metrics` (`vllm:prefix_cache_hits_total` против `vllm:prefix_cache_queries_total`).
- **Симптом:** `ValueError: Invalid prefix_match_unit=N; all KV cache group block sizes must be divisible by prefix_match_unit.` **Причина:** неудачный `--prefix-match-unit`. **Лечение:** взять делитель всех размеров блоков из сообщения.
- **Подтверждение принятого значения:** отдельной строки в логе нет, и в стартовую строку конфига это поле не выводится; эффект виден только по метрикам попаданий в prefix cache.

## Примеры

```bash
vllm serve /models/hybrid-mamba-model --enable-prefix-caching --mamba-cache-mode align --prefix-match-unit 64 --enable-mamba-shared-prefix-checkpoint --speculative-config '{"method": "mtp", "num_speculative_tokens": 1}'
```

```bash
vllm serve /models/hybrid-mamba-model --enable-prefix-caching --mamba-cache-mode align --prefix-match-unit 64 --no-enable-mamba-shared-prefix-checkpoint
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/kv_cache_manager.py`
- `vllm/vllm/v1/core/kv_cache_coordinator.py`
- `vllm/vllm/v1/core/single_type_kv_cache_manager.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/docs/features/automatic_prefix_caching.md`
- `vllm/tests/v1/core/test_prefix_caching.py`
- upstream-коммит `49ee12d74` «[Misc] Rename --enable-mamba-fine-grained-prefix-cache (#53945 follow-up) (#57382)» в checkout'е
