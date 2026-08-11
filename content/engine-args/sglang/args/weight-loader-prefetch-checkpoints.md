---
schema: 1
engine: sglang
primaryName: "--weight-loader-prefetch-checkpoints"
title: "--weight-loader-prefetch-checkpoints"
summary: Прогревает safetensors-шарды в page cache фоновым потоком до того, как их прочитает загрузчик. Ускоряет холодный старт на сетевом хранилище, на локальном NVMe бесполезен и вдобавок молча выключает многопоточную загрузку.
group: model
related:
  - --weight-loader-prefetch-num-threads
  - --weight-loader-disable-mmap
  - --weight-loader-drop-cache-after-load
  - --model-loader-extra-config
  - --load-format
  - --tp-size
---

# --weight-loader-prefetch-checkpoints

## Кратко

Флаг включает предварительное последовательное чтение файлов чекпойнта, чтобы страницы попали в page cache хоста раньше, чем к ним обратится mmap-загрузчик. Это лечит один конкретный класс проблемы: несколько локальных рангов на одном узле независимо mmap'ят один и тот же чекпойнт с NFS/Lustre и генерируют N-кратный сетевой трафик. С prefetch каждый ранг читает свою `1/N` часть шардов, и сетевой объем падает с `N × checkpoint` до `1 × checkpoint`. На локальном NVMe эффекта нет, а побочный эффект есть — по умолчанию отключается многопоточная загрузка.

## Оригинальная справка

```text
Prefetch checkpoint files into OS page cache before loading. Each rank prefetches a fraction of the shards, reducing total network I/O on shared filesystems (NFS/Lustre) from N*checkpoint to 1*checkpoint. Recommended for models on network storage. When enabled, multi-threaded safetensors loading is disabled by default to avoid I/O oversubscription with the prefetch threads; set enable_multithread_load=true in --model-loader-extra-config to keep multi-threaded loading (e.g. on local NVMe where prefetch is a no-op).
```

## Паспорт аргумента

- Флаги: `--weight-loader-prefetch-checkpoints`
- Группа: `model`
- Тип значения: булев переключатель (`store_true`); парной формы `--no-...` нет
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но **сам переопределяет** другое: при включении и отсутствии явного `enable_multithread_load`/`num_threads` в `--model-loader-extra-config` многопоточная загрузка safetensors выключается (с предупреждением в логе)
- Где объявлен: `ServerArgs.weight_loader_prefetch_checkpoints`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: загрузка весов — `DefaultModelLoader._get_weights_iterator`

## Что меняет в движке

Значение читается напрямую из конфиг-бага модели в `DefaultModelLoader._get_weights_iterator` (`sglang/python/sglang/srt/model_loader/loader.py`) и передается в итераторы весов как `prefetch=`.

Условия, при которых prefetch действительно запускается (`sglang/python/sglang/srt/model_loader/weight_utils.py`):

- формат весов — safetensors (для `*.bin`/`*.pt` итераторы параметра `prefetch` вообще не принимают);
- не задан `--weight-loader-disable-mmap` (в обоих итераторах условие буквально `if prefetch and not disable_mmap`) — что логично: без mmap prefetch бессмысленен, файл и так читается целиком в RAM;
- `--load-format` не `fastsafetensors` (у этого итератора нет параметра prefetch);
- загрузчик — `DefaultModelLoader` или его наследники, использующие `_get_weights_iterator`. `BitsAndBytesModelLoader`, например, вызывает `safetensors_weights_iterator(hf_weights_files)` без параметров и флаг игнорирует.

Как это работает: `_prefetch_all_checkpoints` берет отсортированный список шардов, делит его срезом `sorted_files[local_rank::local_world_size]` (именно **node-local** ранг — page cache не общий между узлами), запускает пул из `--weight-loader-prefetch-num-threads` потоков и в **фоновом** потоке последовательно читает свою долю файлов блоками по 16 МиБ (`SGLANG_PREFETCH_BLOCK_SIZE_MB`). Прочитанные байты выбрасываются — цель только в том, чтобы страницы осели в page cache. Загрузка при этом не блокируется и начинается сразу: prefetch должен идти впереди загрузчика, а не вместо него.

Побочный эффект на многопоточность: `use_multithread` по умолчанию `True` (`extra_config.get("enable_multithread_load", True)`). Если prefetch включен, mmap не выключен, формат не `fastsafetensors`, и в `--model-loader-extra-config` нет ни `enable_multithread_load`, ни `num_threads` — загрузчик печатает предупреждение и переключается на однопоточный итератор, чтобы prefetch-потоки и загрузочные потоки не соревновались за одну и ту же полосу I/O.

## Значения и формат

Переключатель без значения. Прогресс логируется каждые 10 % (`Rank <n>: prefetching checkpoint files: <pct>% (<done>/<total>)`), в конце — суммарное время (`Rank <n>: prefetching checkpoint files into page cache finished in <t>s`).

Ошибка чтения отдельного файла не фатальна: `Failed to prefetch checkpoint file '<path>'` с трассировкой, остальные файлы продолжают прогреваться.

Размер блока чтения настраивается переменной окружения `SGLANG_PREFETCH_BLOCK_SIZE_MB` (по умолчанию 16), CLI-флага для него нет.

## Когда использовать

- Чекпойнт лежит на NFS/Lustre/сетевом томе, и на узле несколько рангов (`--tp-size > 1` или DP-attention). Именно здесь эффект максимален и измерим: сетевой трафик падает кратно числу локальных рангов.
- Не включайте на локальном NVMe или на одном ранге: prefetch там ничего не выигрывает, зато молча отключит многопоточную загрузку и **замедлит** старт. Если все-таки хотите оставить флаг, верните многопоточность: `--model-loader-extra-config '{"enable_multithread_load": true}'`.
- Не включайте вместе с `--weight-loader-disable-mmap`: комбинация просто выключает prefetch без предупреждения.

## Влияние на производительность и память

- RAM хоста: prefetch наполняет page cache объемом до полного чекпойнта на узел. Это не анонимная память процесса, ядро вытеснит ее под давлением, но на хосте с большим CPU-оффлоадом (KTransformers) конкуренция за page cache реальна — там же живут CPU-веса экспертов.
- Время холодного старта: на сетевом хранилище с несколькими рангами сокращается за счет устранения дублирующего трафика. На повторном старте (страницы уже в кеше) prefetch отработает почти мгновенно и не помешает.
- VRAM не затрагивается.
- Отключение многопоточной загрузки — измеримая цена на быстром локальном диске.
- CPU: `--weight-loader-prefetch-num-threads` потоков на ранг, занятых последовательным чтением.

## Взаимодействие с другими аргументами

- `--weight-loader-prefetch-num-threads`: число потоков prefetch на ранг; имеет смысл только при включенном флаге.
- `--weight-loader-disable-mmap`: взаимно исключающая пара — при `disable_mmap` prefetch не запускается.
- `--weight-loader-drop-cache-after-load`: прямой антагонист по смыслу. Prefetch наполняет page cache, drop-cache его освобождает после каждого шарда. Вместе они дают «прочитали заранее — сразу отпустили»: осмысленно, только если вы боретесь с CPU OOM, а не с медленным чтением.
- `--model-loader-extra-config`: единственный способ вернуть многопоточную загрузку (`enable_multithread_load` или `num_threads`).
- `--load-format`: `fastsafetensors` prefetch не поддерживает; `bitsandbytes` его игнорирует.
- `--tp-size` (и число локальных рангов вообще): определяет, на сколько частей делится работа prefetch и насколько велик выигрыш.

## Типовые проблемы и диагностика

- Предупреждение `--weight-loader-prefetch-checkpoints is enabled; falling back to single-threaded weight loading to avoid I/O oversubscription with the prefetch threads. Set enable_multithread_load=true in --model-loader-extra-config to keep multi-threaded loading.` — ожидаемое поведение, а не ошибка. На локальном диске это сигнал, что флаг вам не нужен.
- Флаг задан, но строк про prefetch в логе нет — сработало одно из условий отключения: `--weight-loader-disable-mmap`, `--load-format fastsafetensors`, не-safetensors чекпойнт или загрузчик, не использующий `_get_weights_iterator`.
- `ValueError: weight loader prefetch num_threads must be >= 1` — задано `--weight-loader-prefetch-num-threads` меньше 1. Ошибка возникает на этапе загрузки, а не при разборе CLI.
- `Failed to prefetch checkpoint file '<path>'` — проблема с доступом к конкретному шарду; загрузка продолжится, но именно этот файл будет читаться «холодным».
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /mnt/nfs/models/Qwen3-30B-A3B --tp-size 4 --weight-loader-prefetch-checkpoints --weight-loader-prefetch-num-threads 8
```

```bash
python -m sglang.launch_server --model-path /nvme/models/Qwen3-30B-A3B --weight-loader-prefetch-checkpoints --model-loader-extra-config '{"enable_multithread_load": true}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/model_loading.mdx`
