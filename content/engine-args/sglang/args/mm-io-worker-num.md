---
schema: 1
engine: sglang
primaryName: "--mm-io-worker-num"
title: "--mm-io-worker-num"
summary: Ширина пула потоков, который скачивает и декодирует картинки, видео и аудио перед препроцессингом. Определяет, сколько сырых декодированных объектов одновременно живет в RAM хоста.
group: mm
related:
  - --mm-processor-worker-num
  - --tokenizer-worker-num
  - --limit-mm-data-per-request
  - --mm-process-config
  - --disable-fast-image-processor
  - --enable-multimodal
---

# --mm-io-worker-num

## Кратко

`--mm-io-worker-num` задает `max_workers` пула `sglang-mm-io` — потоков, на которых выполняется `_load_single_item`: скачивание по URL или чтение из base64/файла, декодирование JPEG/PNG, выборка кадров видео, ресемплинг аудио. Это первый по счету параллельный этап мультимодального тракта и первое место, где занимается RAM хоста. `0` (по умолчанию) означает «взять модель-специфичный дефолт»: 4 у большинства процессоров, 16 у Qwen-VL и Kimi.

## Оригинальная справка

```text
Number of threads for multimodal data loading and decoding. 0 selects the model-specific default. SGLANG_IO_WORKERS remains supported as an environment override when this argument is 0.
```

## Паспорт аргумента

- Флаги: `--mm-io-worker-num`
- Группа: `mm`
- Тип значения: int
- Допустимые значения: неотрицательное целое; `assert self.mm_io_worker_num >= 0, "Multimodal I/O worker num must >= 0"` в `__post_init__`
- Значение по умолчанию: `0` — «модель-специфичный дефолт»
- Эффективное значение: разрешается в конструкторе `BaseMultimodalProcessor` по цепочке «аргумент → переменная окружения `SGLANG_IO_WORKERS` → `auto_mm_io_worker_num` процессора»
- Где объявлен: `ServerArgs.mm_io_worker_num`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструирование мультимодального процессора в tokenizer-процессе; далее — на каждый запрос с мультимодальными данными

## Что меняет в движке

Разрешение значения (`sglang/python/sglang/srt/multimodal/processors/base_processor.py`):

```python
requested_mm_io_worker_num = self.server_args.mm_io_worker_num
env_mm_io_worker_num = os.environ.get("SGLANG_IO_WORKERS")
if requested_mm_io_worker_num:
    self.mm_io_worker_num = requested_mm_io_worker_num   # explicit
elif env_mm_io_worker_num is not None:
    self.mm_io_worker_num = int(env_mm_io_worker_num)    # environment
else:
    self.mm_io_worker_num = self.auto_mm_io_worker_num   # auto
```

Три следствия, каждое из которых стоит держать в голове:

1. Проверка `if requested_mm_io_worker_num:` — на истинность, а не на `None`. Поэтому `--mm-io-worker-num 0` не «отключает пул», а означает «авто».
2. `SGLANG_IO_WORKERS` читается напрямую из `os.environ`, минуя реестр `environ.py`, и действует **только** когда аргумент равен нулю. Явно заданный аргумент переменную перебивает.
3. Значение `0` из переменной окружения (`SGLANG_IO_WORKERS=0`) попадет в `ThreadPoolExecutor(max_workers=0)` и приведет к `ValueError: max_workers must be greater than 0` при конструировании процессора — ассерт `>= 0` этот путь не покрывает, потому что проверяет аргумент, а не переменную.

Модель-специфичные дефолты `auto_mm_io_worker_num`: `4` в базовом классе; `16` у Qwen-VL (для `qwen2_vl`, `qwen2_5_vl`, `qwen3_vl`, `qwen3_vl_moe`, `qwen3_5`, `qwen3_5_moe`, `intern_s2_preview`, `interns2_mobius`), Kimi K2.5 и Kimi K3.

Что именно выполняется в этих потоках (`_load_single_item`):

- **image** — `load_image(data, cls.gpu_image_decode)`. Если процессор объявил GPU-декодирование (`gpu_image_decode = True` или `"nvjpeg_fancy"`), JPEG декодируется через nvJPEG и возвращается уже тензором на GPU; иначе декод идет PIL'ом на CPU, причем `img.load()` вызывается прямо здесь, чтобы ленивое декодирование не всплыло позже на event loop.
- **video** — `load_video(data, frame_count_limit)`: выборка кадров с учетом лимита.
- **audio** — `load_audio(data, audio_sample_rate)`.

Ошибки загрузки заворачиваются в `ValueError`/`RuntimeError` с обрезанным до 100 символов описанием источника.

Рядом с этим пулом в том же конструкторе создается ещё один — `cpu_executor`, `ProcessPoolExecutor` на `SGLANG_CPU_WORKERS` процессов (по умолчанию `os.cpu_count()`). Он используется отдельными процессорами (например LLaVA) и к `--mm-io-worker-num` отношения не имеет, но именно он обычно и объясняет «откуда столько процессов Python».

## Значения и формат

- Целое ≥ 0. Отрицательное отвергается ассертом при старте.
- `0` — авто (4 или 16 по процессору), с возможностью переопределения через `SGLANG_IO_WORKERS`.
- Любое положительное значение отключает влияние `SGLANG_IO_WORKERS`.
- Верхней границы нет; ограничитель практический — RAM и пропускная способность сети.

## Когда использовать

- Запросы приносят изображения по URL, и время ожидания сети доминирует над всем остальным: увеличение пула прямо сокращает TTFT, потому что скачивания идут параллельно. Это единственный случай, где смело идут выше 16.
- Много мелких изображений на запрос и CPU-декодирование (`gpu_image_decode = False` у процессора): пул распараллеливает PIL.
- **Уменьшайте**, если хост уходит в своп при бурстах: каждый одновременно обрабатываемый элемент держит декодированное изображение целиком (для 4K RGB это ~25 МиБ на кадр) или пачку кадров видео.
- **Не увеличивайте**, если данные приходят base64 и уже локально, а тормозит вызов процессора — это `--mm-processor-worker-num`.

## Влияние на производительность и память

- **RAM хоста.** Верхняя оценка пика: `--tokenizer-worker-num × --mm-io-worker-num × (размер одного декодированного элемента)`. Для видео «один элемент» — это все выбранные кадры сразу, поэтому именно видео дает самые злые всплески. Ограничение сверху ставится не этим аргументом, а `--mm-process-config` (`max_frames`, `max_pixels`) и `--limit-mm-data-per-request`.
- **CPU.** Потоки конкурируют за ядра с пулом процессора, с процессным пулом `SGLANG_CPU_WORKERS` и с event loop'ом tokenizer'а. На узле, где рядом крутится CPU-инференс (актуально для профиля KTransformers в arriero, `docs/KTRANSFORMERS_OPERATIONS.md`), избыточный пул отбирает такты у самого сервера.
- **VRAM.** При GPU-декодировании (nvJPEG) декодированные изображения появляются сразу на `cuda:<base_gpu_id>`, и число одновременных декодов задается именно этим пулом.
- **Сеть.** Значение = максимальное число одновременных исходящих соединений за медиа-данными на один tokenizer-воркер.
- Время старта: пул создается сразу, но потоки ленивые — стоимость незаметна.

## Взаимодействие с другими аргументами

- `--mm-processor-worker-num`: следующий этап конвейера. Если IO быстрый, а процессор один, расширение IO-пула только увеличит очередь перед ним.
- `--tokenizer-worker-num`: множитель — пул создается в каждом воркере.
- `--limit-mm-data-per-request`: ограничивает, сколько задач один запрос положит в пул.
- `--mm-process-config`: ограничивает размер каждой задачи (`max_frames`, `fps`, `max_pixels`), то есть пиковую RAM на элемент.
- `--disable-fast-image-processor`: влияет на следующий этап (resize/normalize), не на этот.
- `--enable-multimodal`: без мультимодального тракта пул не создается.

## Типовые проблемы и диагностика

- `AssertionError: Multimodal I/O worker num must >= 0` — отрицательное значение аргумента.
- `ValueError: max_workers must be greater than 0` при инициализации процессора — задан `SGLANG_IO_WORKERS=0` при нулевом аргументе.
- `RuntimeError: Error while loading data <url>...: ...` / `ValueError: Error while loading data ...` — ошибка загрузки конкретного элемента, а не проблема размера пула.
- Хост уходит в своп на бурстах мультимодальных запросов — считайте пик как произведение выше; сначала ограничивайте `--mm-process-config`, потом уменьшайте пул.
- Подтверждение в логе печатается **только при значении больше 4**: `Multimodal data loading enabled with N worker threads (explicit|environment|auto).` Слово в скобках прямо показывает, откуда взялось число. При значении ≤ 4 строки нет — это нормально, а не признак того, что аргумент не принят; само значение видно в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-io-worker-num 32 --limit-mm-data-per-request '{"image": 8}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-io-worker-num 4 --mm-processor-worker-num 2 --mm-process-config '{"video":{"fps":2,"max_frames":32}}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/qwen_vl.py`
- `sglang/python/sglang/srt/multimodal/processors/kimi_k3.py`
- `sglang/python/sglang/srt/environ.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
