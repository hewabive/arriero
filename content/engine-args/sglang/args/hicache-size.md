---
schema: 1
engine: sglang
primaryName: "--hicache-size"
title: "--hicache-size"
summary: Абсолютный размер host-пула HiCache в гигабайтах на один rank; ненулевое значение полностью перекрывает `--hicache-ratio`. Гигабайт здесь десятичный (1e9 байт).
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-ratio
  - --tp-size
  - --pp-size
  - --page-size
---

# --hicache-size

## Кратко

`--hicache-size` задает объем L2-пула HiCache напрямую в гигабайтах вместо кратности к device-пулу. Значение `0` (по умолчанию) означает «считать по `--hicache-ratio`». Два момента, на которых обычно ошибаются: гигабайт десятичный (`1e9` байт, не `2^30`), и величина задается **на каждый rank** — при `--tp-size 8` хост отдаст восьмикратный объем. Это правильная ручка, когда бюджет RAM хоста фиксирован и его нельзя превышать.

## Оригинальная справка

```text
The size of host KV cache memory pool in gigabytes, which will override the hicache_ratio if set.
```

## Паспорт аргумента

- Флаги: `--hicache-size`
- Группа: `memory`
- Тип значения: целое (гигабайты)
- Допустимые значения: не ограничены argparse; `0` означает «не задан»
- Значение по умолчанию: `0`
- Эффективное значение: при `> 0` перекрывает `--hicache-ratio`; при `--pp-size > 1` итоговая емкость в токенах синхронизируется по минимуму между PP-стадиями (`sync_fixed_hicache_size`); для DeepSeek V4 аргумент вообще запрещен
- Где объявлен: `ServerArgs.hicache_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор host-пула (`HostKVCache.__init__`) при инициализации дерева кеша

## Что меняет в движке

В `HostKVCache.__init__` (`sglang/python/sglang/srt/mem_cache/pool_host/base.py`) значение переводится в число токенов:

```python
self.size = sync_fixed_hicache_size(int(host_size * 1e9 // self.size_per_token), host_size)
```

`size_per_token` — байты на токен для конкретной модели и rank'а (у MHA-модели это доля голов данного rank'а, у MLA — полная запись). Дальше размер выравнивается вверх на целую страницу: `page_num = size // page_size + 1`, `size = page_num * page_size`.

`sync_fixed_hicache_size` существует из-за pipeline parallelism: разные PP-стадии владеют разными слоями, значит у них разный `size_per_token`, и одинаковые гигабайты дали бы разную емкость в токенах. Поэтому по PP-группе делается `all_reduce(MIN)` и берется минимальная емкость; в лог уходит «Sync fixed-size HiCache host token capacity from N to M.». Для ratio-режима это не нужно — там база уже синхронна.

Для hybrid-моделей (full + SWA, full + Mamba, три пула сразу) `_split_hicache_size` (`mem_cache/hybrid_cache/hybrid_pool_assembler.py`) делит заданные гигабайты между под-пулами **пропорционально их размеру на устройстве** — задавать размер каждого под-пула отдельно нельзя.

Для DeepSeek V4 путь другой: `--hicache-size > 0` приводит к `ValueError` «DeepSeek V4 HiCache currently does not support --hicache-size; use --hicache-ratio instead.».

## Значения и формат

- Целое число гигабайт. `--hicache-size 100` → 100 × 10⁹ байт на rank, а не 100 ГиБ.
- `0` — специальное значение «не задан», управление возвращается `--hicache-ratio`.
- Отрицательные значения argparse примет, но ветка `host_size > 0` не сработает, и размер снова посчитается по ratio — то есть отрицательное значение эквивалентно нулю. Не полагайтесь на это.
- Аргумент не гарантирует, что столько памяти есть: перед аллокацией проверяется `psutil.virtual_memory().available` с резервом 10 ГиБ, и при нехватке старт падает.

## Когда использовать

- Хост общий: рядом живут другие инстансы, сборка, индексация. Фиксированный потолок предсказуемее кратности, которая «уезжает» при каждом изменении `--mem-fraction-static`.
- В arriero это основной режим: объем L2 надо заранее внести в host memory draw инстанса, а draw описывается абсолютной величиной (`docs/RESOURCE_MANAGEMENT.md`).
- Возвращайтесь к `--hicache-ratio`, если модель и `--mem-fraction-static` часто меняются и хочется, чтобы L2 масштабировался сам.
- Не используйте на DeepSeek V4 — старт откажет.

## Влияние на производительность и память

- RAM хоста: ровно заданный объем × число rank'ов в процессе, память закрепленная (pinned), выделяется на старте.
- VRAM не затрагивается.
- Время старта растет с объемом: аллокация и регистрация pinned-памяти линейны по размеру.
- Hit rate L2 растет сублинейно; увеличение сверх горячего набора дает мало.
- Слишком маленькое значение хуже, чем отсутствие HiCache: расходы на write-back остаются, а переиспользование почти не работает — об этом предупреждает строка «L2 cache effectiveness is reduced».

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: без него значение не читается.
- `--hicache-ratio`: перекрывается этим аргументом при любом `> 0`.
- `--tp-size`: величина — на rank. Суммарный расход = `hicache_size × tp_size` (для MLA-моделей это реплики одних и тех же данных).
- `--pp-size` > 1: емкость в токенах приводится к минимуму по стадиям, то есть фактический объем на «толстых» стадиях будет меньше заданного.
- `--page-size`: округление вверх до целой страницы.
- `--hicache-mem-layout`: layout влияет на `size_per_token` только через раскладку, но не на суммарный объем — гигабайты остаются гигабайтами.

## Типовые проблемы и диагностика

- «Not enough host memory available. Requesting X GB but only have Y GB free.» — заданный объем не помещается с учетом резерва 10 ГиБ. Учтите, что при TP > 1 запрос делает каждый rank.
- `ValueError: DeepSeek V4 HiCache currently does not support --hicache-size` — переключитесь на `--hicache-ratio`.
- «Sync fixed-size HiCache host token capacity from N to M.» — сработало PP-выравнивание, реальная емкость меньше заданной.
- Фактический объем печатает пул: «Allocating kv hierarchical KV host pool: N tokens, X.XX GB host memory.» — сверяйте именно с ним, а не с аргументом.
- Если значение задано, а лог показывает объем «по ratio», проверьте, что `--enable-hierarchical-cache` действительно включен и что модель не hybrid, где гигабайты делятся между под-пулами.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-size 100
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-size 60 --hicache-write-policy write_through_selective --hicache-storage-backend file
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/base.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_pool_assembler.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
