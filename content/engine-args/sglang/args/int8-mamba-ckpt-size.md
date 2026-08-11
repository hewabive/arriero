---
schema: 1
engine: sglang
primaryName: "--int8-mamba-ckpt-size"
title: "--int8-mamba-ckpt-size"
summary: Число слотов int8-пула закешированных mamba-состояний. Читается только вместе с `--enable-int8-mamba-checkpoint`; по умолчанию берется удвоенный размер активного пула, и эта память не входит ни в один бюджетный расчет.
group: exec.mamba
related:
  - --enable-int8-mamba-checkpoint
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
  - --mamba-ssm-dtype
  - --mem-fraction-static
  - --mamba-max-states-per-path
---

# --int8-mamba-ckpt-size

## Кратко

Размер отдельного пула, куда `--enable-int8-mamba-checkpoint` складывает закешированные рекуррентные состояния. Единица измерения — слоты, ровно как у `--max-mamba-cache-size`, но это **другие** слоты: они дешевле и обслуживают не работающие запросы, а узлы radix-дерева. Значение по умолчанию — двойной размер активного пула. Ключевая особенность: этот объем не участвует в решении бюджетной задачи (`--mamba-full-memory-ratio` / `--mem-fraction-static`), а проверяется по фактически свободной HBM непосредственно перед аллокацией.

## Оригинальная справка

```text
Number of int8 mamba checkpoint slots (default: 2x the active mamba pool size).
```

## Паспорт аргумента

- Флаги: `--int8-mamba-ckpt-size`
- Группа: `exec.mamba`
- Тип значения: int (`Optional[int]`), единица — слоты
- Допустимые значения: положительное целое; argparse ограничений не накладывает
- Значение по умолчанию: `null` — разворачивается в `2 * mamba_size`, где `mamba_size` — размер активного пула (`--max-mamba-cache-size` после всех подстановок)
- Эффективное значение: `mamba.int8_mamba_ckpt_size or (2 * mamba_size)` в `maybe_init_int8_mamba_checkpoint_pool`; фактически выделяется на один слот больше (`slot 0` зарезервирован аллокатором)
- Где объявлен: `ServerArgs.int8_mamba_ckpt_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание `HybridReqToTokenPool` — после расчета основного бюджета памяти и после аллокации активного пула

## Что меняет в движке

Значение целиком определяет размер трех тензоров checkpoint-пула. Формула из `MambaCheckpointPool.estimate_mem_usage_bytes` (`slots = N + 1`):

```text
qdata = L * slots * H * d_v * d_k                       # int8, 1 байт
scale = L * slots * H * d_k * itemsize(ssm_dtype)
conv  = L * slots * sum(prod(conv_shape)) * itemsize(conv_dtype)
```

где `L` — число линейных/mamba-слоев на ранге, `H, d_v, d_k` — временнáя форма состояния.

Численно на Qwen3-Next-80B-A3B при `--tp-size 1` (36 линейных слоев, форма `(32, 128, 128)`, conv `(8192, 3)`):

| `--mamba-ssm-dtype` | один checkpoint-слот | один активный слот | во сколько раз дешевле |
| --- | --- | --- | --- |
| `float32` | 20.25 MiB (qdata 18.00 + scale 0.56 + conv 1.69) | 73.69 MiB | 3.6 |
| `bfloat16` | 19.97 MiB (qdata 18.00 + scale 0.28 + conv 1.69) | 37.69 MiB | 1.9 |

То есть `--int8-mamba-ckpt-size 512` на этой модели стоит примерно 10.1 ГиБ — сопоставимо со всей свободной памятью карты 24 ГиБ. Значение по умолчанию (двойной активный пул) на маленьком активном пуле безобидно, но при большом активном пуле легко перебирает.

Перед аллокацией движок читает `torch.cuda.mem_get_info` и, если оценка больше свободной памяти, падает с явным `RuntimeError` вместо невнятного CUDA OOM внутри аллокации.

## Значения и формат

- Целое число слотов; суффиксов нет.
- Значение не делится на attention-DP ранги (в отличие от `--max-mamba-cache-size`): оно задает размер пула на ранге как есть.
- Без `--enable-int8-mamba-checkpoint` значение не читается вовсе.
- Слишком маленькое значение не ломает старт: кеш просто быстрее вытесняет собственные чекпоинты, и hit rate падает.
- Проверки «не меньше активного пула» нет — можно задать заведомо бесполезное значение вроде `1`.

## Когда использовать

- Когда автоматический двойной размер не влезает в свободную память: задать явное значение вместо того, чтобы понижать `--mem-fraction-static` (второе отнимет память у KV-пула, первое — только у кеша состояний).
- Когда hit rate префиксного кеша высокий, а вытеснения чекпоинтов частые: увеличить, если карта позволяет.
- Начинать стоит с расчета по формуле выше, а не с «круглого» числа: цена слота линейно зависит от числа слоев модели и от `--mamba-ssm-dtype`.
- Не задавать больше, чем реально может быть узлов в дереве под вашей нагрузкой: лишние слоты — просто занятая VRAM.

## Влияние на производительность и память

- VRAM: линейно, `(N + 1) × размер checkpoint-слота`, поверх всего остального. Это единственный существенный эффект аргумента.
- RAM хоста: не влияет.
- Время старта: одна крупная аллокация; на 10 ГиБ это заметно, но однократно.
- Throughput: косвенно — больше слотов, реже вытеснение закешированных состояний, выше вероятность попадания в префикс и короче TTFT на повторяющихся диалогах.
- Latency: прямого влияния нет.

## Взаимодействие с другими аргументами

- `--enable-int8-mamba-checkpoint`: единственный флаг, при котором значение читается.
- `--max-mamba-cache-size`: задает `mamba_size`, от которого берется значение по умолчанию (`2 ×`).
- `--mamba-ssm-dtype`: определяет тип масштабов, то есть небольшую часть цены слота, и всю цену активного слота — то есть коэффициент выигрыша.
- `--mem-fraction-static`: сообщение об ошибке предлагает понизить его как альтернативу уменьшению этого значения; так вы освободите память, зарезервированную под статику.
- `--mamba-max-states-per-path`: ограничивает число чекпоинтов на путь и тем самым снижает потребность в большом пуле.
- `--mamba-full-memory-ratio`: делит бюджет между активным пулом состояний и KV; checkpoint-пул в этом делении не участвует.

## Типовые проблемы и диагностика

- `RuntimeError: int8 mamba checkpoint pool needs ~X GB but only Y GB HBM is free. Lower --int8-mamba-ckpt-size (currently N) or --mem-fraction-static.` — самый частый исход при значении по умолчанию на большом активном пуле.
- Задали значение, а лог показывает другое число слотов — вы не включили `--enable-int8-mamba-checkpoint`, и пула нет вовсе.
- Внезапный CUDA OOM на первых запросах после успешного старта — checkpoint-пул съел резерв, из которого брались активации и CUDA graph; понижайте `--mem-fraction-static` или размер пула.
- Что смотреть в логе: `int8 mamba checkpoint pool: N slots, X.XXGB (qdata … + scale … + conv …); active mamba pool M slots; free HBM … GB` — там сразу видны и принятое число слотов, и разбивка по тензорам, и остаток свободной памяти.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-int8-mamba-checkpoint --int8-mamba-ckpt-size 128
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-int8-mamba-checkpoint --int8-mamba-ckpt-size 64 --max-mamba-cache-size 96 --mamba-ssm-dtype bfloat16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/mamba_checkpoint_pool.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/configs/qwen3_next.py`
