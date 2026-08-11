---
schema: 1
engine: sglang
primaryName: "--enable-int8-mamba-checkpoint"
title: "--enable-int8-mamba-checkpoint"
summary: Выносит закешированные radix-кешем рекуррентные состояния в отдельный int8-пул: примерно вчетверо дешевле fp32-слота, живые запросы при этом остаются в полной точности. Несовместим с `--enable-hierarchical-cache` и с внешним `--radix-cache-backend`.
group: exec.mamba
related:
  - --int8-mamba-ckpt-size
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
  - --mamba-ssm-dtype
  - --mamba-max-states-per-path
  - --enable-hierarchical-cache
  - --radix-cache-backend
  - --disable-radix-cache
  - --mem-fraction-static
  - --enable-unified-memory
---

# --enable-int8-mamba-checkpoint

## Кратко

Без этого флага закешированное состояние и активное состояние живут в одном пуле и стоят одинаково: каждый узел radix-дерева удерживает полноценный слот. Флаг разделяет два назначения — активный пул остается в объявленном типе (`--mamba-ssm-dtype`) и обслуживает работающие запросы, а закешированные состояния уходят в отдельный `MambaCheckpointPool`, где временнáя часть хранится в int8 с масштабом на каждую пару (голова, k-канал). Цена одного закешированного состояния падает примерно в 3.6 раза относительно fp32-слота и в 1.9 раза относительно bf16. Ошибка вносится ровно один раз — при записи в кеш; при попадании состояние деквантуется в свежий активный слот и дальше декодирование идет в полной точности.

## Оригинальная справка

```text
Store radix-cached linear-attn (mamba) states in int8 (separate checkpoint pool) for ~2x cached-prefix capacity at fixed memory.
```

## Паспорт аргумента

- Флаги: `--enable-int8-mamba-checkpoint`
- Группа: `exec.mamba`
- Тип значения: bool (флаг без значения)
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; автоматически не включается
- Где объявлен: `ServerArgs.enable_int8_mamba_checkpoint`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_int8_mamba_checkpoint` — два запрета) → создание `HybridReqToTokenPool` (аллокация отдельного пула, после расчета основного бюджета) → работа префиксного кеша

## Что меняет в движке

### Пул

`maybe_init_int8_mamba_checkpoint_pool` (`sglang/python/sglang/srt/mem_cache/mamba_checkpoint_pool.py`) создает `MambaCheckpointPool` рядом с активным `MambaPool`. На каждый слот хранятся:

- `qdata` формы `[L, slots, H, d_v, d_k]` в int8 — квантованная временнáя часть;
- `scale` формы `[L, slots, H, 1, d_k]` в типе исходного состояния — масштаб на каждую пару (голова, k-канал); ось редукции — `d_v`, что совпадает с осью покомпонентного затухания;
- `conv` — окно свертки в своем нативном типе, без квантования (оно маленькое).

Выбор int8, а не fp8, в исходниках обоснован тем, что состояние распределено примерно равномерно, и при одинаковом байте на элемент int8 с поканальным масштабом точнее, чем fp8-e4m3 с его экспонентой.

### Где эта память учитывается

Нигде в бюджетном решении. Пул состояний и KV-пул считаются в `_handle_max_mamba_cache` до и без учета checkpoint-пула; сам checkpoint-пул выделяется позже и сравнивается с **фактически свободной** HBM через `torch.cuda.mem_get_info`. Если оценка не влезает, старт падает:

```text
int8 mamba checkpoint pool needs ~X GB but only Y GB HBM is free. Lower --int8-mamba-ckpt-size (currently N) or --mem-fraction-static.
```

Практическое следствие для arriero: заявленный GPU-draw инстанса (`docs/RESOURCE_MANAGEMENT.md`) нужно увеличивать на объем этого пула вручную — он не выводится из `--mem-fraction-static`.

### Что меняется в учете занятости

Закешированные состояния больше не занимают слотов активного пула, поэтому наблюдатель статистики (`pool_stats_observer.py`) при включенном флаге сообщает `mamba_evictable_size = 0` против активного пула: иначе `size - (available + evictable)` уходило бы в минус. Занятость самого int8-пула проверяется отдельным инвариантом.

## Значения и формат

- Флаг без значения; парной формы нет.
- Размер пула задается отдельным `--int8-mamba-ckpt-size`; по умолчанию — удвоенный размер активного пула плюс один служебный слот.
- Работает только со встроенным mamba-путем radix-кеша: любой `--radix-cache-backend` отвергается.
- Не работает вместе с host-выгрузкой: `--enable-hierarchical-cache` отвергается.
- При `--enable-unified-memory` пул не создается (`mamba_ckpt_pool = None` в unified-пуле) — флаг молча не действует.
- При `--disable-radix-cache` кешировать нечего, и пул бесполезен.

## Когда использовать

- Когда нагрузка дает высокий hit rate префиксного кеша на гибридной модели, и в статистике видно, что заметная часть пула состояний занята закешированными, а не работающими запросами.
- Когда конкурентность режется пулом состояний (`max_running_requests is capped to N by the mamba state cache …`), но отказываться от кеша не хочется: это способ разделить два потребителя вместо того, чтобы душить один другим.
- Не включать вместе с `--enable-hierarchical-cache` — придется выбрать одно; host-путь не умеет читать int8-слоты и старт это отвергнет заранее, чтобы не портить состояния.
- Не включать без запаса свободной VRAM: пул выделяется сверх всего уже посчитанного бюджета.
- Альтернатива при нехватке памяти — `--mamba-max-states-per-path`: он не добавляет памяти, а ограничивает удержание слотов кешем.

## Влияние на производительность и память

- VRAM: **добавляет** отдельный пул. Численно на Qwen3-Next-80B-A3B (36 линейных слоев, `(32, 128, 128)`, tp=1) один checkpoint-слот стоит 20.25 MiB при `--mamba-ssm-dtype float32` (qdata 18 MiB + scale 0.56 MiB + conv 1.69 MiB) против 73.7 MiB активного fp32-слота; при `bfloat16` — 19.97 MiB против 37.7 MiB активного.
- RAM хоста: не влияет.
- Время старта: добавляется одна крупная аллокация и проверка свободной памяти; лог печатает точный объем.
- Latency: квантование выполняется один раз на запись в кеш, деквантование — один раз на попадание; на самом decode это не сказывается.
- Качество: одно округление состояния на весь путь через кеш. Ошибка сконцентрирована на мелких компонентах состояния, крупные сохраняют точность около bf16 благодаря поканальному масштабу.

## Взаимодействие с другими аргументами

- `--int8-mamba-ckpt-size`: число слотов checkpoint-пула; по умолчанию вдвое больше активного.
- `--mamba-ssm-dtype`: определяет тип масштабов (и, косвенно, цену активного слота, с которой сравнивается выигрыш).
- `--enable-hierarchical-cache`: взаимно исключающая пара, отказ на старте.
- `--radix-cache-backend`: любой внешний backend отвергается.
- `--enable-unified-memory`: пул не создается.
- `--mem-fraction-static`: пул выделяется из остатка после статики, поэтому при тесном бюджете статику придется понизить.
- `--mamba-max-states-per-path`: работает поверх — ограничивает число закешированных состояний на путь независимо от того, где они лежат.

## Типовые проблемы и диагностика

- `ValueError: --enable-int8-mamba-checkpoint is not supported together with --enable-hierarchical-cache: the host-offload path is not int8-aware. Disable one of them.`
- `ValueError: --enable-int8-mamba-checkpoint only supports the built-in mamba radix cache; --radix-cache-backend='…' is not int8-aware. Omit --radix-cache-backend.`
- `RuntimeError: int8 mamba checkpoint pool needs ~X GB but only Y GB HBM is free …` — уменьшайте `--int8-mamba-ckpt-size` или `--mem-fraction-static`.
- Флаг задан, а памяти не прибавилось и лога о пуле нет — проверьте, не включен ли `--enable-unified-memory` и не отключен ли radix-кеш.
- Что смотреть в логе: строку `int8 mamba checkpoint pool: N slots, X.XXGB (qdata … + scale … + conv …); active mamba pool M slots; free HBM … GB` и принятое значение в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-int8-mamba-checkpoint
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-int8-mamba-checkpoint --int8-mamba-ckpt-size 512 --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/mamba_checkpoint_pool.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/unified_memory_pool.py`
- `sglang/python/sglang/srt/managers/scheduler_components/pool_stats_observer.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
