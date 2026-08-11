---
schema: 1
engine: sglang
primaryName: "--weight-loader-disable-mmap"
title: "--weight-loader-disable-mmap"
summary: Заставляет читать каждый safetensors-шард целиком в анонимную память вместо mmap. Помогает на ФС, где mmap медленный или ненадежный, ценой пикового расхода RAM и отключения prefetch.
group: model
related:
  - --weight-loader-prefetch-checkpoints
  - --weight-loader-prefetch-num-threads
  - --weight-loader-drop-cache-after-load
  - --model-loader-extra-config
  - --load-format
---

# --weight-loader-disable-mmap

## Кратко

По умолчанию safetensors-шарды открываются через `safetensors.safe_open` — это mmap, тензоры читаются лениво страницами, а память под них учитывается как page cache. Флаг переключает загрузчик на `safetensors.torch.load(f.read())`: шард читается обычным `read()` целиком в анонимную память процесса и там разбирается. Это нужно на файловых системах, где mmap работает плохо (часть сетевых и оверлейных ФС, FUSE), и на них же он обычно ускоряет загрузку. Цена — пик RSS порядка размера шарда (умноженный на число загрузочных потоков) и полное отключение prefetch.

## Оригинальная справка

```text
Disable mmap while loading weight using safetensors.
```

## Паспорт аргумента

- Флаги: `--weight-loader-disable-mmap`
- Группа: `model`
- Тип значения: булев переключатель (`store_true`); парной формы `--no-...` нет
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но сам отключает prefetch (`if prefetch and not disable_mmap` в обоих safetensors-итераторах)
- Где объявлен: `ServerArgs.weight_loader_disable_mmap`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: загрузка весов — `DefaultModelLoader._get_weights_iterator`

## Что меняет в движке

Значение передается в safetensors-итераторы `sglang/python/sglang/srt/model_loader/weight_utils.py` как `disable_mmap=`. Внутри каждого из них ветвление одно и то же:

```
if disable_mmap:
    with open(st_file, "rb") as f:
        result = safetensors.torch.load(f.read())
else:
    with safetensors.safe_open(st_file, framework="pt", device="cpu") as f:
        ...
```

Флаг действует на три итератора: однопоточный `safetensors_weights_iterator`, `multi_thread_safetensors_weights_iterator` и `buffered_multi_thread_safetensors_weights_iterator` (последний и используется по умолчанию в `DefaultModelLoader`). На путь `fastsafetensors` (`--load-format fastsafetensors`) он не распространяется — там своя логика с GPU Direct Storage. На `*.bin`/`*.pt` он тоже не влияет: их итераторы параметра не имеют.

Второй эффект — отключение prefetch. Оба итератора, умеющие prefetch, проверяют `if prefetch and not disable_mmap`, поэтому `--weight-loader-prefetch-checkpoints` вместе с этим флагом молча не работает. Логика прямая: prefetch наполняет page cache ради последующих mmap-обращений, а без mmap этих обращений нет.

Есть и разница в порядке выдачи тензоров: в mmap-ветке однопоточного итератора ключи отдаются в порядке `f.keys()`, в ветке без mmap — `sorted(result.keys())`. На результат это не влияет, но объясняет разный порядок строк в подробных логах загрузки.

## Значения и формат

Переключатель без значения. Никаких проверок и специальных значений нет.

Практическая арифметика пика памяти: в буферизованном многопоточном загрузчике «в полете» одновременно до `max_workers + 1` шардов (по умолчанию `max_workers = 8`, настраивается ключом `num_threads` в `--model-loader-extra-config`), и докстринг итератора прямо оценивает пик как `(max_workers + 2) × размер_шарда`. С `disable_mmap` эти шарды лежат в анонимной памяти процесса, а не в вытесняемом page cache — то есть считаются в RSS и попадают под OOM-killer.

## Когда использовать

- Чекпойнт лежит на ФС, где mmap патологически медленный или проблемный: часть NFS-конфигураций, FUSE-монтирования, оверлейные ФС в контейнерах. Симптом — загрузка весов идет в разы дольше, чем позволяет пропускная способность тома, при почти нулевой загрузке CPU.
- Не включайте «для скорости» на локальном диске: обычный путь через mmap там и быстрее, и экономнее по анонимной памяти.
- Не включайте вместе с `--weight-loader-prefetch-checkpoints`: prefetch будет молча отключен, а вы будете считать, что он работает.
- На хосте с большим CPU-оффлоадом (KTransformers, где RAM уже занята весами экспертов) включайте только после подсчета пика: `(num_threads + 2) × размер_шарда` анонимной памяти — реальная величина.

## Влияние на производительность и память

- RAM хоста: главный эффект. Память под шарды становится анонимной и невытесняемой на время удержания; пик пропорционален числу загрузочных потоков.
- Page cache: при чтении через `read()` страницы файла все равно проходят через page cache ядра, поэтому кеш тоже растет — но освободить его можно `--weight-loader-drop-cache-after-load`.
- Время холодного старта: на «плохой для mmap» ФС сокращается, на нормальной локальной — растет за счет лишнего копирования из page cache в анонимную память.
- Повторный старт: без mmap повторный старт не выигрывает от того, что страницы уже в кеше, настолько же, насколько выигрывает mmap-путь — данные все равно копируются целиком.
- VRAM не затрагивается.

## Взаимодействие с другими аргументами

- `--weight-loader-prefetch-checkpoints` и `--weight-loader-prefetch-num-threads`: взаимно исключены с этим флагом (prefetch не запустится).
- `--weight-loader-drop-cache-after-load`: совместим и осмыслен — `posix_fadvise(DONTNEED)` после каждого шарда снимает page cache, накопленный обычным чтением.
- `--model-loader-extra-config`: ключ `num_threads` (по умолчанию 8) прямо умножает пиковую анонимную память в этом режиме; `enable_multithread_load: false` сводит пик к одному шарду.
- `--load-format`: `fastsafetensors` флаг не поддерживает; `bitsandbytes` его игнорирует; `pt`/`npcache` тоже.

## Типовые проблемы и диагностика

- Процесс убит OOM-killer'ом на этапе `Multi-thread loading shards` — слишком большой пик анонимной памяти. Уменьшите `num_threads` в `--model-loader-extra-config` либо снимите флаг.
- Флаг задан, prefetch включен, а строк `prefetching checkpoint files ...` нет — это ожидаемое взаимодействие, а не поломка.
- Загрузка не ускорилась — mmap не был узким местом; посмотрите, не упирается ли чтение в полосу тома (`Loading safetensors checkpoint shards` идет с ожидаемой скоростью).
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /mnt/fuse/models/Qwen3-30B-A3B --weight-loader-disable-mmap --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /mnt/fuse/models/Qwen3-30B-A3B --weight-loader-disable-mmap --weight-loader-drop-cache-after-load --model-loader-extra-config '{"num_threads": 2}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/docs/docs/advanced_features/model_loading.mdx`
