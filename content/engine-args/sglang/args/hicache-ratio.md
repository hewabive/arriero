---
schema: 1
engine: sglang
primaryName: "--hicache-ratio"
title: "--hicache-ratio"
summary: Кратность host-пула HiCache относительно device-пула KV, в токенах. Работает только при `--enable-hierarchical-cache` и только если `--hicache-size` не задан.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-size
  - --mem-fraction-static
  - --page-size
  - --tp-size
---

# --hicache-ratio

## Кратко

`--hicache-ratio` задает, во сколько раз L2-пул HiCache в памяти хоста больше KV-пула на GPU. Единица счета — **токены**, не байты: движок берет `device_pool.size` (число слотов KV на карте) и умножает на ratio. Байты получаются уже из этого числа и размера одного токена для конкретной модели, поэтому один и тот же ratio на разных моделях дает совершенно разный расход RAM. Аргумент читается только при включенном `--enable-hierarchical-cache` и молча игнорируется, если задан ненулевой `--hicache-size`.

## Оригинальная справка

```text
The ratio of the size of host KV cache memory pool to the size of device pool.
```

## Паспорт аргумента

- Флаги: `--hicache-ratio`
- Группа: `memory`
- Тип значения: float
- Допустимые значения: argparse ограничений не накладывает; осмысленны значения строго больше `1.0` — при меньших host-пул оказывается меньше device-пула, и L2 почти бесполезен
- Значение по умолчанию: `2.0`
- Эффективное значение: перекрывается любым `--hicache-size > 0`; итоговый размер дополнительно округляется вверх до целого числа страниц
- Где объявлен: `ServerArgs.hicache_ratio`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор host-пула (`HostKVCache.__init__`) при инициализации дерева кеша, то есть после того, как device-пул уже выделен

## Что меняет в движке

Значение уходит в конструктор `HostKVCache` (`sglang/python/sglang/srt/mem_cache/pool_host/base.py`) как `host_to_device_ratio`. Формула ровно такая:

```python
if host_size > 0:
    self.size = sync_fixed_hicache_size(int(host_size * 1e9 // self.size_per_token), host_size)
else:
    self.size = int(device_pool.size * host_to_device_ratio)
self.page_num = self.size // self.page_size + 1
self.size = self.page_num * self.page_size
```

То есть `--hicache-ratio` используется **только** в ветке `host_size == 0` и работает над числом токенов device-пула. Дальше размер выравнивается вверх на целую страницу (`--page-size`), и по `self.size * self.size_per_token` считается требуемый объем RAM.

Для hybrid-моделей (full + SWA, full + Mamba) тот же ratio передается в каждый под-пул отдельно (`mem_cache/hybrid_cache/hybrid_pool_assembler.py`), то есть суммарный расход RAM — сумма по под-пулам.

Для DeepSeek V4 расчет идет в страницах: `full_host_pages = int(device_full_pages * ratio)` и аналогично для SWA-части; там же `--hicache-size` явно запрещен.

## Значения и формат

- Дробное число, `2.0` по умолчанию. `--hicache-ratio 3` и `--hicache-ratio 3.0` эквивалентны.
- Значение ≤ 1 не отвергается, но при старте появится предупреждение «HiCache … host pool (N tokens) is smaller than the device pool (M tokens); L2 cache effectiveness is reduced.» — L2 не сможет удержать даже то, что вытесняется из L1.
- `0` не «отключает» host-пул: это не тот же ноль, что у `--hicache-size`. Ноль в ratio даст `size = 0`, после выравнивания — одну страницу, то есть фактически неработающий L2.
- Верхней границы нет; ограничитель — проверка доступной RAM с резервом 10 ГиБ.

## Когда использовать

- Когда объем host-пула должен масштабироваться вместе с device-пулом: изменили `--mem-fraction-static` или модель — L2 подстроился сам.
- Когда host-пулов несколько (hybrid-модель, несколько rank'ов) и считать точные гигабайты на каждый неудобно.
- Оставьте дефолт `2.0`, если нет измеренной причины: апстрим прямо отмечает, что зависимость «размер кеша → hit rate» нелинейна и после насыщения горячими токенами прирост минимален.
- Переключитесь на `--hicache-size`, когда важен абсолютный потолок по RAM хоста (типичный случай для arriero: host-пул делится с memory draw других инстансов, `docs/RESOURCE_MANAGEMENT.md`).

## Влияние на производительность и память

- RAM хоста растет линейно: `device_pool.size * ratio * size_per_token` байт на каждый rank, память закрепленная (pinned).
- VRAM не затрагивается.
- Время старта растет с размером буфера — аллокация и `cudaHostRegister` большого pinned-региона не бесплатны.
- Hit rate L2 растет сублинейно; после того как весь горячий набор помещается, дальнейшее увеличение только съедает RAM.
- На throughput в момент вытеснения влияет опосредованно: чем больше L2, тем реже приходится терять префикс совсем.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: без него значение не читается.
- `--hicache-size`: любой `> 0` полностью перекрывает ratio. Для DeepSeek V4 `--hicache-size` запрещен — там управлять размером можно только через ratio.
- `--mem-fraction-static`, `--max-total-tokens`, `--context-length`: определяют `device_pool.size`, то есть базу, на которую умножается ratio. Увеличили KV-пул на GPU — автоматически выросло и потребление RAM.
- `--page-size`: размер выравнивается вверх до целого числа страниц.
- `--tp-size`: host-пул создается на каждом rank; для MHA-моделей каждый rank хранит свою долю голов, для MLA — реплику. Общий расход RAM хоста считайте по всем rank'ам процесса.

## Типовые проблемы и диагностика

- «Not enough host memory available. Requesting X GB but only have Y GB free.» — ratio слишком большой для текущей RAM; уменьшите его или уменьшите device-пул. Порог = `MemAvailable − 10 ГиБ`.
- Предупреждение «L2 cache effectiveness is reduced» — ratio ≤ 1.
- Фактически выделенный объем печатает сам пул: «Allocating kv hierarchical KV host pool: N tokens, X.XX GB host memory.» — это и есть единственная надежная проверка, во что превратился ваш ratio.
- Значение, как его принял движок, — в дампе `server_args=` при старте.
- Если ожидали изменения, а лог показывает прежний объем, проверьте, не задан ли `--hicache-size`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 4
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --page-size 64 --enable-hierarchical-cache --hicache-ratio 2 --hicache-io-backend direct --hicache-mem-layout page_first_direct
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/base.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_pool_assembler.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
