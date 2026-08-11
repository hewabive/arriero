---
schema: 1
engine: vllm
primaryName: "--safetensors-load-strategy"
title: "--safetensors-load-strategy"
summary: Как читать safetensors: mmap (`lazy`), полностью в RAM (`eager`), прогрев page cache в фоне (`prefetch`) или реконструкция torchao-подклассов. Не задано — движок сам включает prefetch на NFS/Lustre, если чекпоинт влезает в 90 % свободной RAM.
group: LoadConfig
related:
  - --load-format
  - --safetensors-prefetch-num-threads
  - --safetensors-prefetch-block-size
  - --model-loader-extra-config
  - --download-dir
  - --quantization
  - --use-tqdm-on-load
---

# --safetensors-load-strategy

## Кратко

Safetensors по умолчанию читается через mmap: тензоры подтягиваются страницами по мере обращения. На локальном NVMe это идеально, на сетевой файловой системе — катастрофа, потому что превращается в поток мелких случайных чтений с сетевой задержкой на каждое.

Аргумент выбирает поведение явно. Значение по умолчанию `None` — не то же самое, что `lazy`: `None` дополнительно включает автоматический prefetch, если определен сетевой тип ФС и чекпоинт помещается в 90 % свободной RAM.

## Оригинальная справка

```text
Specifies the loading strategy for safetensors weights.

- None (default): Uses memory-mapped (lazy) loading. When an NFS
  filesystem is detected and the total checkpoint size fits within 90%%
  of available RAM, prefetching is enabled automatically.
- "lazy": Weights are memory-mapped from the file. This enables
  on-demand loading and is highly efficient for models on local storage.
  Unlike the default (None), auto-prefetch on NFS is not performed.
- "eager": The entire file is read into CPU memory upfront before loading.
  This is recommended for models on network filesystems (e.g., Lustre, NFS)
  as it avoids inefficient random reads, significantly speeding up model
  initialization. However, it uses more CPU RAM.
- "prefetch": Checkpoint files are read into the OS page cache before
  workers load them, speeding up the model loading phase. Useful on
  network or high-latency storage.
- "torchao": Weights are loaded in upfront and then reconstructed
  into torchao tensor subclasses. This is used when the checkpoint
  was quantized using torchao and saved using safetensors.
  Needs `torchao >= 0.14.0`.
```

## Паспорт аргумента

- Флаги: `--safetensors-load-strategy`
- Группа argparse: `LoadConfig`
- Тип значения: enum (строка), `optional: true`
- Допустимые значения: `lazy`, `eager`, `prefetch`, `torchao`; поскольку тип допускает `None`, argparse добавляет к списку значение `None`
- Значение по умолчанию: `None` — «lazy плюс авто-prefetch на сетевой ФС»
- Эффективное значение: может быть заменено на `torchao` в `DefaultModelLoader.load_weights`, если `--quantization torchao`, чекпоинт сериализован torchao и установлен `torchao >= 0.15.0`
- Где объявлен: `vllm/config/load.py:LoadConfig.safetensors_load_strategy`
- Этап применения: чтение весов (`safetensors_weights_iterator`)

## Что меняет в движке

Перед чтением `safetensors_weights_iterator` (`vllm/model_executor/model_loader/weight_utils.py`) определяет тип файловой системы по `/proc/mounts` (правило самого длинного совпадения точки монтирования), суммарный размер чекпоинта и доступную RAM (минимум из значений хоста и cgroup) и печатает:

```text
Filesystem type for checkpoints: <FS>. Checkpoint size: X.XX GiB. Available RAM: Y.YY GiB.
```

Дальше:

- **`None`** — prefetch включается автоматически, если ФС распознана как `nfs`, `nfs4` или `lustre` **и** чекпоинт ≤ 90 % доступной RAM. В остальных комбинациях движок печатает, почему авто-prefetch не сработал, и читает лениво.
- **`lazy`** — mmap без авто-prefetch, даже на сетевой ФС.
- **`eager`** — файл читается целиком в память (`load(f.read())`), затем разбирается. Прогресс-бар получает суффикс `(eager)`.
- **`prefetch`** — фоновой поток (`_prefetch_all_checkpoints`) последовательно вычитывает файлы блоками в page cache, пока основной путь читает их обычным mmap. Файлы распределяются по рангам как `sorted_files[rank::world_size]`, то есть каждый ранг греет свою долю.
- **`torchao`** — тензоры читаются целиком и реконструируются в подклассы torchao (`unflatten_tensor_state_dict`); требует `torchao >= 0.14.0`, а автоматическая подстановка режима — `>= 0.15.0`.

## Значения и формат

- Одно из четырех значений или `None`. Регистр важен.
- `None` можно записать явно (`--safetensors-load-strategy None`) — парсер `optional_type` превращает строки `None` и пустую в `None`.
- `eager` требует, чтобы файл поместился в RAM целиком; при `prefetch` и нехватке RAM движок предупреждает, но не отказывается.
- Стратегия применяется только к обычному safetensors-итератору `DefaultModelLoader`. Форматы `fastsafetensors`, `instanttensor`, `runai_streamer`, `sharded_state`, `tensorizer` ее не читают.
- Комбинация с `enable_multithread_load` (`--model-loader-extra-config`) допустима только при `None` или `lazy`; остальные значения отвергаются явной ошибкой.

## Когда использовать

- **`eager`** — веса на Lustre/NFS, RAM хватает с запасом, и старт важнее памяти. Самый простой способ убрать случайные сетевые чтения.
- **`prefetch`** — веса на сетевом или медленном хранилище, но в RAM целиком не влезают либо хочется совместить чтение с параллельной работой: греет page cache в фоне, не блокируя загрузку.
- **`lazy`** — веса на локальном NVMe, и вы хотите гарантированно отключить любую эвристику (например, том смонтирован как NFS, но фактически быстрый).
- **`torchao`** — только для torchao-квантованных чекпоинтов; в норме выставляется движком автоматически.
- Не задавайте `eager` вслепую на большой модели: пик RAM равен размеру одного файла, а на хосте с ограниченной памятью это OOM хоста в фазе загрузки.

## Влияние на производительность и память

- **Время старта.** Основной эффект, и он целиком определяется хранилищем. На сетевой ФС `eager`/`prefetch` дают кратное ускорение фазы `Loading weights`; на локальном NVMe разницы почти нет.
- **RAM хоста.** `eager` — пик в размер читаемого файла; `prefetch` — рост page cache на размер чекпоинта (память переиспользуемая, но она отражается в потреблении хоста); `lazy` — минимальный.
- **VRAM.** Не влияет.
- **CPU.** `prefetch` расходует потоки на последовательное чтение (`--safetensors-prefetch-num-threads`).
- **Throughput после старта.** Не влияет: стратегия действует только в фазе загрузки.

## Взаимодействие с другими аргументами

- `--load-format`: определяет, дойдет ли дело до safetensors-итератора вообще.
- `--safetensors-prefetch-num-threads`, `--safetensors-prefetch-block-size`: параметры именно prefetch-режима (явного или авто).
- `--model-loader-extra-config`: `enable_multithread_load` конфликтует со всеми значениями, кроме `None`/`lazy`.
- `--download-dir`: определяет, на какой файловой системе окажется чекпоинт, а значит и результат авто-эвристики.
- `--quantization`: значение `torchao` вместе с torchao-сериализованным чекпоинтом заставляет движок подставить стратегию `torchao`.
- `--use-tqdm-on-load`: прогресс-бар чтения (`Loading safetensors checkpoint shards`, с суффиксом `(eager)` в eager-режиме).

## Типовые проблемы и диагностика

- **Симптом:** загрузка весов занимает десятки минут при быстрой сети. **Причина:** mmap по NFS. **Проверка:** строка `Filesystem type for checkpoints: NFS4 ...` и отсутствие сообщений о prefetch. **Лечение:** `eager` или `prefetch`.
- **Симптом:** `Network filesystem (NFS4) detected but checkpoint total size (X GiB) exceeds 90% of available RAM (Y GiB). Skipping auto-prefetch.` **Лечение:** явный `prefetch` (предупреждение о риске останется) либо освободить RAM.
- **Симптом:** `Auto-prefetch is disabled because the filesystem (EXT4) is not a recognized network FS (NFS/Lustre). If you want to force prefetching, start vLLM with --safetensors-load-strategy=prefetch.` **Причина:** информационное сообщение, не ошибка.
- **Симптом:** `safetensors_load_strategy='prefetch' was explicitly specified, but checkpoint total size ... exceeds 90% of available RAM ... This may cause out-of-memory errors.` **Лечение:** взвесить риск; при нехватке RAM вернуться к `lazy`.
- **Симптом:** процесс убит OOM-killer'ом в фазе загрузки. **Причина:** `eager` на модели, которая не влезает в RAM. **Лечение:** `prefetch` или `lazy`.
- **Симптом:** `Please use torchao version >= 0.15.0 to load torchao safetensors checkpoint` **Лечение (arriero):** собрать новое окружение с подходящей версией `torchao` — существующие окружения неизменяемы (`docs/ENVIRONMENTS.md`).
- **Подтверждение принятого значения:** строки `Prefetching checkpoint files into page cache started (in background, num_threads=N, block_size=M bytes)` и `Prefetching checkpoint files: 10% (x/y)` для prefetch; суффикс `(eager)` в описании прогресс-бара для eager.

## Примеры

```bash
vllm serve /mnt/lustre/models/Qwen3-4B --safetensors-load-strategy eager
```

```bash
vllm serve /mnt/nfs/models/Qwen3-32B --safetensors-load-strategy prefetch --safetensors-prefetch-num-threads 16 --safetensors-prefetch-block-size 32M
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/engine/arg_utils.py`
- `docs/ENVIRONMENTS.md` (arriero)
