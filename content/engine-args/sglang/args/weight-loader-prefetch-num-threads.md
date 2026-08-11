---
schema: 1
engine: sglang
primaryName: "--weight-loader-prefetch-num-threads"
title: "--weight-loader-prefetch-num-threads"
summary: Число потоков prefetch на один ранг. Читается только при включенном `--weight-loader-prefetch-checkpoints`; значение меньше 1 роняет загрузку весов уже после разбора CLI.
group: model
related:
  - --weight-loader-prefetch-checkpoints
  - --weight-loader-disable-mmap
  - --weight-loader-drop-cache-after-load
  - --model-loader-extra-config
  - --tp-size
---

# --weight-loader-prefetch-num-threads

## Кратко

Единственная задача аргумента — задать ширину пула потоков, которым ранг прогревает свою долю шардов чекпойнта в page cache. Он имеет смысл только вместе с `--weight-loader-prefetch-checkpoints`; без него значение никуда не доходит. Настраивают его под характер хранилища: сетевой ФС нужна параллельность, чтобы выбрать полосу, локальному диску хватает единиц потоков.

## Оригинальная справка

```text
Number of threads per rank for checkpoint prefetching (default: 4).
```

## Паспорт аргумента

- Флаги: `--weight-loader-prefetch-num-threads`
- Группа: `model`
- Тип значения: целое
- Допустимые значения: `choices` нет; проверка одна — `num_threads >= 1`, и она выполняется в момент запуска prefetch, а не при разборе CLI
- Значение по умолчанию: `4`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.weight_loader_prefetch_num_threads`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: загрузка весов — `_prefetch_all_checkpoints` в `sglang/python/sglang/srt/model_loader/weight_utils.py`

## Что меняет в движке

Значение читается в `DefaultModelLoader._get_weights_iterator` и передается в safetensors-итераторы как `prefetch_num_threads=`. Оттуда оно доходит до `_prefetch_all_checkpoints`, где становится `max_workers` для `ThreadPoolExecutor` и одновременно глубиной очереди: пул стартует с `num_threads` файлов, и по мере завершения каждого подставляется следующий. То есть одновременно читается ровно `num_threads` шардов этого ранга.

Каждый поток читает свой файл последовательно блоками по 16 МиБ (`SGLANG_PREFETCH_BLOCK_SIZE_MB`) и выбрасывает прочитанное — работа делается ради page cache.

Число потоков задается **на ранг**, а список шардов уже поделен между локальными рангами (`sorted_files[local_rank::local_world_size]`). Суммарная нагрузка на хранилище с одного узла — это `local_world_size × num_threads` параллельных последовательных читателей.

Первым делом функция проверяет `if num_threads < 1: raise ValueError("weight loader prefetch num_threads must be >= 1")`. argparse ноль и отрицательные значения принимает, поэтому ошибка возникает уже на этапе загрузки весов — после инициализации распределенных групп.

## Значения и формат

- Целое, минимум `1`. `0` и отрицательные значения — `ValueError` на загрузке.
- Верхней границы нет; практический потолок задает хранилище, а не движок.
- Значение бессмысленно без `--weight-loader-prefetch-checkpoints`: prefetch не запускается, и параметр никуда не попадает.
- Значение также не используется, если prefetch отключен по одной из внутренних причин: `--weight-loader-disable-mmap`, `--load-format fastsafetensors`, не-safetensors чекпойнт.

## Когда использовать

- Сетевое хранилище (NFS/Lustre/объектный том с POSIX-слоем), где одиночный последовательный читатель не выбирает полосу: увеличивайте до 8-16 и смотрите на строку `prefetching checkpoint files into page cache finished in <t>s`.
- Много локальных рангов на узле: помните про умножение. При 8 рангах и 8 потоках это 64 параллельных читателя к одному тому — на общем сторадже это уже может быть хуже, чем меньшее число.
- Локальный NVMe: значение по умолчанию `4` избыточно, но и безвредно — там сам prefetch обычно не нужен.
- Не трогайте, если prefetch выключен: аргумент не будет иметь эффекта, а в дампе `server_args` создаст ложное впечатление настройки.

## Влияние на производительность и память

- Время холодного старта: главная и единственная метрика этого аргумента. Оптимум ищется по времени завершения prefetch в логе.
- CPU: потоки заняты чтением, не вычислением; нагрузка на процессор невелика, но потоки конкурируют с загрузчиком весов за I/O — ровно поэтому prefetch по умолчанию отключает многопоточную загрузку.
- RAM хоста: число потоков не меняет объем page cache, который в итоге займет чекпойнт; оно меняет только скорость его наполнения. Пиковой анонимной памяти prefetch не добавляет — блок 16 МиБ на поток.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--weight-loader-prefetch-checkpoints`: обязательный включатель.
- `--weight-loader-disable-mmap`: отключает prefetch целиком, вместе с этим параметром.
- `--model-loader-extra-config`: ключ `num_threads` в нем — это **другое**: он задает число потоков многопоточного загрузчика safetensors (по умолчанию 8), а не prefetch. Не путайте их; присутствие `num_threads` в extra-config к тому же отменяет автоматическое отключение многопоточной загрузки.
- `--tp-size` и число локальных рангов: множитель суммарной нагрузки на хранилище.
- `--weight-loader-drop-cache-after-load`: работает после загрузки шарда и с числом prefetch-потоков не связан.

## Типовые проблемы и диагностика

- `ValueError: weight loader prefetch num_threads must be >= 1` — задан `0` или отрицательное значение. Ошибка приходит поздно, уже при загрузке весов.
- Prefetch не ускоряет старт при большом числе потоков — обычно уперлись в полосу тома или в конкуренцию с другими рангами. Считайте `local_world_size × num_threads`.
- Строки `Rank <n>: prefetching <k>/<total> checkpoint shards into page cache (background, <m> local ranks sharing the work, <t> threads per rank)...` в начале и `Rank <n>: prefetching checkpoint files into page cache finished in <t>s` в конце — единственный источник фактических цифр по этому аргументу.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /mnt/lustre/models/Qwen3-30B-A3B --tp-size 2 --weight-loader-prefetch-checkpoints --weight-loader-prefetch-num-threads 8
```

```bash
python -m sglang.launch_server --model-path /mnt/nfs/models/Qwen3-30B-A3B --weight-loader-prefetch-checkpoints --weight-loader-prefetch-num-threads 2 --model-loader-extra-config '{"enable_multithread_load": true, "num_threads": 4}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/model_loading.mdx`
