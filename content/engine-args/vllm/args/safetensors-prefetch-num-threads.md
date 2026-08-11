---
schema: 1
engine: vllm
primaryName: "--safetensors-prefetch-num-threads"
title: "--safetensors-prefetch-num-threads"
summary: Сколько потоков параллельно вычитывают файлы чекпоинта в page cache при активном prefetch. По умолчанию 8; имеет смысл только на хранилище, которое выигрывает от параллельных чтений.
group: LoadConfig
related:
  - --safetensors-load-strategy
  - --safetensors-prefetch-block-size
  - --load-format
  - --download-dir
  - --tensor-parallel-size
  - --model-loader-extra-config
---

# --safetensors-prefetch-num-threads

## Кратко

При включенном prefetch движок поднимает фоновый поток, внутри него — `asyncio`-цикл и пул из `N` рабочих потоков, каждый из которых последовательно вычитывает один файл чекпоинта блоками. `--safetensors-prefetch-num-threads` задает `N`.

Параллелизм здесь нужен не ради CPU, а ради очереди хранилища: одно последовательное чтение не насыщает ни NFS, ни NVMe с глубокой очередью.

## Оригинальная справка

```text
Number of worker threads used to prefetch safetensors checkpoint files
into the OS page cache when safetensors prefetching is enabled.
```

## Паспорт аргумента

- Флаги: `--safetensors-prefetch-num-threads`
- Группа argparse: `LoadConfig`
- Тип значения: int (число потоков); человекочитаемые суффиксы для этого аргумента не включены
- Допустимые значения: `>= 1` (валидация `Field(default=..., ge=1)`), плюс повторная проверка `>= 1` в `_prefetch_all_checkpoints`
- Значение по умолчанию: `Field(default=DEFAULT_SAFETENSORS_PREFETCH_NUM_THREADS, ge=1)`, где константа равна `8`
- Эффективное значение: не переопределяется движком
- Где объявлен: `vllm/config/load.py:LoadConfig.safetensors_prefetch_num_threads`
- Этап применения: чтение весов, только при активном prefetch

## Что меняет в движке

`_prefetch_all_checkpoints` (`vllm/model_executor/model_loader/weight_utils.py`) создает `ThreadPoolExecutor(max_workers=num_prefetch_threads)` и раздает ему файлы. Важная деталь распределения:

```
paths_to_prefetch = sorted_files[rank::world_size]
```

Каждый ранг греет **свою долю** файлов — при tensor parallel 4 каждый из четырех процессов возьмет каждый четвертый файл. Суммарная нагрузка на хранилище, соответственно, равна `world_size × num_threads` одновременных чтений, а не `num_threads`.

Весь пул работает в отдельном демоне-потоке (`threading.Thread(target=_run_prefetch, daemon=True)`), поэтому загрузка весов не блокируется прогревом и идет параллельно. Прогресс печатается декадами:

```text
Prefetching checkpoint files: 10% (3/30)
```

Ошибка чтения одного файла логируется предупреждением `Failed to prefetch checkpoint file '<путь>'` и не прерывает ни прогрев, ни загрузку.

## Значения и формат

- Целое число, минимум 1. `0` и отрицательные отвергаются валидацией поля; та же проверка продублирована в `_prefetch_all_checkpoints`.
- `1` превращает прогрев в строго последовательный — осмысленно на хранилище, которое деградирует от параллельных чтений.
- Значения выше числа файлов чекпоинта бесполезны: лишние потоки останутся без работы (файлы распределяются по одному на задачу).
- Специальных значений (`0`, `-1`, `auto`) нет.

## Когда использовать

- Сетевая ФС с высокой задержкой: параллельные чтения перекрывают latency, и 8–16 потоков дают заметный выигрыш.
- Чекпоинт из многих мелких шардов: параллелизм по файлам работает тем лучше, чем их больше.
- Уменьшайте до 1–2, если prefetch мешает основному чтению весов (конкуренция за одну и ту же очередь диска) или если хранилище общее и его нельзя перегружать.
- Не трогайте, если prefetch не активен: аргумент не будет прочитан.
- Учитывайте tensor parallel: при `--tensor-parallel-size 8` и восьми потоках хранилище увидит 64 параллельных чтения.

## Влияние на производительность и память

- **Время старта.** Единственная область влияния — длительность прогрева. Потолок определяется пропускной способностью хранилища, а не числом потоков.
- **RAM хоста.** Буферы чтения — `num_threads × block_size` (при дефолтах 8 × 16 MiB = 128 MiB). Основное потребление дает page cache размером в чекпоинт и от этого аргумента не зависит.
- **CPU.** Потоки в основном ждут ввод-вывод; заметной нагрузки на процессор не создают.
- **VRAM.** Не влияет.
- **Throughput после старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--safetensors-load-strategy`: единственный включатель prefetch; без него аргумент мертв.
- `--safetensors-prefetch-block-size`: второй параметр той же подсистемы; произведение двух значений и есть объем одновременно читаемых данных на процесс.
- `--tensor-parallel-size` (и любой другой параллелизм, поднимающий несколько рангов): множит нагрузку на хранилище, поскольку файлы делятся по рангам, а потоки — внутри каждого.
- `--load-format`: prefetch применяется только к обычному safetensors-итератору.
- `--download-dir`: определяет расположение чекпоинта и, соответственно, оптимальный параллелизм.
- `--model-loader-extra-config`: `enable_multithread_load` несовместим с явным `prefetch` — это разные механизмы распараллеливания, и движок запрещает их комбинировать.

## Типовые проблемы и диагностика

- **Симптом:** значение задано, эффекта нет. **Причина:** prefetch не активен. **Проверка:** строка `Prefetching checkpoint files into page cache started (in background, num_threads=N, block_size=M bytes)`. **Лечение:** задать `--safetensors-load-strategy prefetch`.
- **Симптом:** прогрев завершается уже после того, как веса загружены (`Prefetching ... finished in X.XXs` позже, чем `Loading weights took Y.YY seconds`). **Причина:** прогрев не успевает и пользы не приносит. **Лечение:** увеличить число потоков и/или размер блока, либо перейти на `eager`.
- **Симптом:** после увеличения числа потоков хранилище деградировало, старт стал дольше. **Причина:** перегрузка очереди, особенно с учетом множителя по рангам. **Лечение:** снизить значение.
- **Симптом:** `safetensors prefetch num threads must be >= 1` **Лечение:** задать положительное число.
- **Симптом:** предупреждения `Failed to prefetch checkpoint file '<путь>'`. **Причина:** недоступность файла; загрузка при этом продолжится ленивым чтением. **Лечение:** проверить хранилище.
- **Подтверждение принятого значения:** `num_threads=N` в стартовой строке prefetch.

## Примеры

```bash
vllm serve /mnt/nfs/models/Qwen3-32B --safetensors-load-strategy prefetch --safetensors-prefetch-num-threads 16
```

```bash
vllm serve /mnt/nfs/models/Qwen3-32B --safetensors-load-strategy prefetch --safetensors-prefetch-num-threads 2 --safetensors-prefetch-block-size 64M --tensor-parallel-size 4
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/engine/arg_utils.py`
