---
schema: 1
engine: sglang
primaryName: "--weight-loader-drop-cache-after-load"
title: "--weight-loader-drop-cache-after-load"
summary: После загрузки каждого шарда вызывает `posix_fadvise(DONTNEED)` и освобождает его страницы из page cache. Лечит нехватку RAM на хосте ценой того, что повторный старт снова читает чекпойнт с диска.
group: model
related:
  - --weight-loader-prefetch-checkpoints
  - --weight-loader-disable-mmap
  - --weight-loader-prefetch-num-threads
  - --load-format
  - --model-loader-extra-config
---

# --weight-loader-drop-cache-after-load

## Кратко

Флаг заставляет загрузчик сразу после того, как содержимое шарда скопировано в тензоры, попросить ядро выбросить его страницы из page cache. Это компромисс в пользу RAM хоста: пиковое давление на память во время загрузки падает, но чекпойнт перестает «жить» в кеше — следующий старт того же инстанса прочитает его с диска заново. В комментарии кода мотив назван прямо: избежать CPU OOM в RL-сценариях, где рядом крутится тренер.

## Оригинальная справка

```text
Call posix_fadvise(DONTNEED) on each safetensors shard after loading it.
```

## Паспорт аргумента

- Флаги: `--weight-loader-drop-cache-after-load`
- Группа: `model`
- Тип значения: булев переключатель (`store_true`); парной формы `--no-...` нет
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.weight_loader_drop_cache_after_load`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: загрузка весов, после выдачи тензоров каждого шарда

## Что меняет в движке

Значение передается в итераторы весов как `drop_cache_after_load=`. Реализация — `_drop_file_cache_after_load` в `sglang/python/sglang/srt/model_loader/weight_utils.py`: открывает файл на чтение и вызывает `os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)`.

Момент вызова зависит от итератора:

- `safetensors_weights_iterator` (однопоточный) — после того, как все тензоры шарда отданы наверх;
- `buffered_multi_thread_safetensors_weights_iterator` (путь по умолчанию) — после выдачи `state_dict` очередного шарда, до продвижения окна;
- `multi_thread_safetensors_weights_iterator` — после выдачи содержимого шарда;
- `fastsafetensors_weights_iterator` — после закрытия загрузчика, для файлов текущего ранга.

Для `*.bin`/`*.pt` и для `np_cache` итераторов параметра нет — флаг там не применяется. Загрузчики, не проходящие через `DefaultModelLoader._get_weights_iterator` (например `BitsAndBytesModelLoader`), его тоже игнорируют.

Важная оговорка, зафиксированная прямо в коде буферизованного итератора: DONTNEED снижает давление на page cache, но при последующем обращении к mmap-тензору страницы могут быть подгружены заново. То есть на mmap-пути это не жесткое «освободили навсегда», а подсказка ядру.

Отказ не фатален: если `posix_fadvise`/`POSIX_FADV_DONTNEED` недоступны на платформе, функция молча выходит; ошибка `OSError` логируется на уровне DEBUG и загрузка продолжается.

## Значения и формат

Переключатель без значения. Область действия — только safetensors-пути (включая `fastsafetensors`). Гранулярность — файл шарда целиком: сбрасывается весь файл, а не прочитанный диапазон.

## Когда использовать

- На хосте, где RAM — дефицит, и после загрузки модели нужна память под другое: KV-оффлоад HiCache в RAM, CPU-эксперты KTransformers, второй инстанс, тренер в RL-цикле. Page cache формально вытесняем, но конкуренция за него реальна и приводит к скачкам latency.
- Разовая загрузка большой модели на узле, который потом будет держать эту модель месяцами: кеш чекпойнта после старта бесполезен, отдать его выгодно.
- Не включайте, если вы часто перезапускаете инстанс и цените быстрый повторный старт: именно этот флаг гарантированно превращает каждый старт в холодный.
- Не включайте вместе с `--weight-loader-prefetch-checkpoints` без причины: одна половина команды греет кеш, вторая его сразу выбрасывает. Осмысленная комбинация только одна — «прочитать по сети один раз параллельно и не оставлять следов в памяти».

## Влияние на производительность и память

- RAM хоста: главный и единственный целевой эффект. После загрузки page cache не удерживает копию чекпойнта.
- Время повторного старта: растет — данные читаются с диска заново. На NVMe это единицы-десятки секунд, на сетевом томе может быть кратно больше.
- Время первого (холодного) старта: практически не меняется; `posix_fadvise` дешев.
- VRAM не затрагивается.
- В arriero это прямо пересекается с хостовым пулом памяти (`docs/RESOURCE_MANAGEMENT.md`): page cache не входит в объявленный memory-draw инстанса, но конкурирует за ту же физическую RAM, из которой считается бюджет хостового пула.

## Взаимодействие с другими аргументами

- `--weight-loader-prefetch-checkpoints`: смысловой антагонист (греет кеш против выбрасывает кеш), но технически совместимы и работают вместе.
- `--weight-loader-disable-mmap`: хорошее сочетание — при чтении через `read()` страницы точно уже не нужны, и сброс безусловно полезен.
- `--load-format`: работает для safetensors и `fastsafetensors`; для `pt`, `npcache`, `bitsandbytes` не применяется.
- `--model-loader-extra-config`: `num_threads` определяет, сколько шардов одновременно «в полете» и, значит, сколько их успевает накопиться в кеше до первого сброса.

## Типовые проблемы и диагностика

- Повторный старт стал заметно дольше — ожидаемая цена флага, а не регрессия.
- Флаг не дал эффекта: чекпойнт не в формате safetensors, либо используется загрузчик, не проходящий через `_get_weights_iterator`.
- Отдельных информационных строк у этого флага нет: успешный `posix_fadvise` ничего не пишет, неудачный пишет `Failed to drop file cache for <path>: <err>` на уровне DEBUG. Проверять эффект надо снаружи — по `free -m` / `/proc/meminfo` (`Cached`) до и после загрузки.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-loader-drop-cache-after-load --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /mnt/nfs/models/Qwen3-30B-A3B --tp-size 2 --weight-loader-prefetch-checkpoints --weight-loader-prefetch-num-threads 8 --weight-loader-drop-cache-after-load
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/docs/docs/advanced_features/model_loading.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
