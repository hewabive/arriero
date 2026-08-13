---
schema: 1
engine: sglang
primaryName: "--mm-feature-transport"
title: "--mm-feature-transport"
summary: Как признаки мультимодальных данных едут из tokenizer-процесса в scheduler: через RAM хоста и `/dev/shm` или через ограниченный пул на GPU (CUDA IPC / CUDA VMM). GPU-транспорты резервируют фиксированный кусок VRAM на базовой карте, при переполнении молча падают обратно в CPU и на одном узле включаются только явно.
group: mm
related:
  - --keep-mm-feature-on-device
  - --tokenizer-worker-num
  - --base-gpu-id
  - --nnodes
  - --pp-size
  - --disaggregation-mode
  - --encoder-only
  - --encoder-transfer-backend
  - --dist-init-addr
  - --enable-multimodal
---

# --mm-feature-transport

## Кратко

Мультимодальные признаки (`pixel_values` и родня) рождаются в tokenizer-процессе, а нужны в процессе scheduler'а. `--mm-feature-transport` выбирает, как они туда попадают: `cpu` — копия в RAM хоста и передача через сегмент `/dev/shm`; `cuda_ipc` — тензор остается на GPU в **ограниченном** пуле и передается по CUDA IPC-хендлу; `cuda_vmm` — то же самое поверх CUDA VMM, для многоузловых GB200/GB300 с MNNVL.

Не задан — почти всегда `cpu`. Единственное исключение авто-выбора: валидированная MNNVL-модель на многоузловом GB200/GB300 со смонтированным IMEX-каналом, там будет `cuda_vmm`. **На одном узле `cuda_ipc` включается только явно.** Апстрим сделал GPU-транспорт opt-in намеренно: пул съедает HBM у KV-кеша даже когда простаивает, а при переполнении все равно деградирует до CPU-пути потензорно.

Если вы читали более раннее описание этого аргумента: до коммита `69bf601e3c` (#34662) авто-выбор на одноузловом CUDA давал `cuda_ipc`, то есть гигабайт VRAM уходил по умолчанию. Теперь наоборот.

## Оригинальная справка

```text
Transport multimodal features through CPU memory, a bounded CUDA IPC pool, or a bounded CUDA VMM pool. Unset uses cpu except for validated multi-node GB200/GB300 MNNVL models, which use cuda_vmm when an IMEX channel is available. Select cuda_ipc explicitly for single-node GPU transport. GPU transports reserve SGLANG_MM_FEATURE_CACHE_MB (default 1024 MiB) on the base GPU and fall back to CPU transport when the pool is full.
```

## Паспорт аргумента

- Флаги: `--mm-feature-transport`
- Группа: `mm`
- Тип значения: строка; поле объявлено как `Optional[Literal["cpu", "cuda_ipc", "cuda_vmm"]]`, choices выводятся из `Literal`
- Допустимые значения: `cpu`, `cuda_ipc`, `cuda_vmm`
- Значение по умолчанию: `null` — «подобрать по развертыванию»
- Эффективное значение: целиком определяется методом `ServerArgs._handle_multimodal_feature_transport`; после него поле всегда содержит одну из трех строк, а `keep_mm_feature_on_device` принудительно сбрасывается в `False`
- Где объявлен: `ServerArgs.mm_feature_transport`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (до запуска tokenizer-воркеров) → конструирование процессора и выделение GPU-пула → каждый запрос с мультимодальными данными

## Что меняет в движке

### Разрешение значения

`_handle_multimodal_feature_transport` выполняется до старта воркеров и разбирает случаи в следующем порядке:

1. Задан устаревший `--keep-mm-feature-on-device` — транспорт принудительно становится `cuda_ipc`; несовместимое явное значение приводит к `ValueError`.
2. Значение не задано:
   - выставлена устаревшая переменная `SGLANG_USE_CUDA_IPC_TRANSPORT` — берется `cuda_ipc`/`cpu` по ней, с предупреждением;
   - `--encoder-only` — `cpu` (выход энкодера едет по `--encoder-transfer-backend`, а не по этому транспорту);
   - модель мультимодальная, платформа CUDA, `--disaggregation-mode null`:
     - `--nnodes 1` ⇒ `cpu`, без всякой записи в лог. GPU-транспорт на одном узле остается за явным `--mm-feature-transport cuda_ipc`;
     - многоузловое развертывание на MNNVL-фабрике **и** смонтированный `/dev/nvidia-caps-imex-channels/channel0` ⇒ `cuda_vmm`, если модель явно поддерживает VMM-транспорт (`supports_cuda_vmm_feature_transport`), иначе `cpu`;
     - иначе `cpu` (при обнаруженном GB200/GB300 без IMEX-канала в лог уходит подсказка);
   - всё остальное ⇒ `cpu`.

Комментарий в коде объясняет выбор в пользу `cpu`: полный пул все равно потензорно деградирует в CPU-транспорт, а простаивающий занимает HBM, который иначе достался бы KV-кешу, — поэтому CUDA IPC оставлен opt-in, а авто-выбор `cuda_vmm` ограничен системами GB200/GB300, где MNNVL/IMEX-стек и так поднят рантаймом.
3. Значение задано явно, но конфликтует с устаревшей переменной окружения — печатается предупреждение, побеждает аргумент.
4. `--encoder-only` вместе с GPU-транспортом — транспорт принудительно опускается до `cpu` с предупреждением.

Затем идут жесткие проверки:

- `cuda_vmm`: требует CUDA (`ValueError: --mm-feature-transport=cuda_vmm requires NVIDIA CUDA.`), запрещен при `--pp-size != 1` и при `SGLANG_RUST_SERVER`;
- `cuda_ipc`: требует CUDA и **строго один узел** (`ValueError: --mm-feature-transport=cuda_ipc only supports a single node.`).

В конце метод пишет `envs.SGLANG_USE_CUDA_IPC_TRANSPORT` в `1`/`0` — то есть переменная окружения становится следствием аргумента, а не наоборот.

### Где физически лежат признаки

- **`cpu`.** После вызова процессора все тензоры из `FEATURE_NAMES` (`pixel_values`, `pixel_values_videos`, `audio_features`, `input_features`) переносятся `.to("cpu")`. Дальше, если развертывание одноузловое, каждый такой тензор оборачивается в `ShmPointerMMData`: создается отдельный сегмент `/dev/shm`, страницы резервируются `posix_fallocate` (чтобы переполнение tmpfs давало ловимую `OSError: ENOSPC`, а не `SIGBUS` посреди копирования), и в scheduler едет только имя сегмента. При заданном `--dist-init-addr` режим транспорта становится `default`, и тензоры пикулятся прямо в сообщение ZMQ.
- **`cuda_ipc`.** На `cuda:<base_gpu_id>` заранее выделяется непрерывный `uint8`-буфер: общий бюджет `SGLANG_MM_FEATURE_CACHE_MB` (по умолчанию 1024 МиБ) **делится нацело** между tokenizer-воркерами, `total // tokenizer_worker_num` на каждого, — так что число воркеров не умножает резерв. Каждый признак копируется в свободный слот пула, а в scheduler едет IPC-хендл со смещением. Жизненным циклом слота управляет `StreamOrderedMmFeaturePool`: в том же буфере лежат управляющие слова «готово» и по одному «подтверждено» на потребителя, а упорядочивание делается `cuStreamWaitValue32`/`cuStreamWriteValue32` без синхронизации по хосту. Период переработки слотов задается `SGLANG_MM_ITEM_MEM_POOL_RECYCLE_INTERVAL_SEC` (0.05 с).
- **`cuda_vmm`.** Та же схема поверх CUDA VMM; при `--nnodes > 1` хендлы делятся как `CUDA FABRIC`, иначе как `POSIX FD`.

### Что происходит при переполнении GPU-пула

`MmItemMemoryPool.wrap_tensor` возвращает `None`, если свободного куска нужного размера нет, и тензор едет обычным (CPU) путем. Один раз на процесс печатается предупреждение:

```text
MmItemMemoryPool has no free chunk large enough for a X MiB tensor (pool size: Y MiB); falling back to non-IPC transport. Consider increasing SGLANG_MM_FEATURE_CACHE_MB.
```

Это принципиально: пул **ограничен**, поэтому расход HBM не зависит от нагрузки. Комментарий в коде объясняет и почему `keep_mm_feature_on_device` принудительно сбрасывается — иначе после промаха пула тензоры оставались бы на устройстве вне пула, и потребление HBM стало бы функцией трафика.

## Значения и формат

- Ровно одна строка из трех; argparse отвергает остальное как `invalid choice`.
- Отсутствие аргумента на одноузловом развертывании эквивалентно `cpu`. Отличие остается только на многоузловом GB200/GB300 с IMEX: там незаданное значение даст `cuda_vmm`, а явный `cpu` — нет.
- `cuda_ipc` несовместим с `--nnodes > 1`; `cuda_vmm` — с `--pp-size > 1`.
- Размер пула этим аргументом не задается — только переменной `SGLANG_MM_FEATURE_CACHE_MB` (в МиБ, на узел, а не на воркер).
- Кеширование pool-хендлов включено по умолчанию и отключается `SGLANG_USE_IPC_POOL_HANDLE_CACHE=0`; оно переиспользует отображения существующего пула и **не** резервирует второй пул.

## Когда использовать

- **Ничего не задавать** — теперь это и есть «безопасный по VRAM» вариант: на одном узле получится `cpu`. Явный `--mm-feature-transport cpu` (как в апстрим-рецепте Kimi-K3) остается корректным способом закрепить поведение в конфиге и защититься от смены дефолта.
- **`cuda_ipc` явно** — одноузловое развертывание, VRAM в достатке, признаки крупные (высокое разрешение, видео): исчезают D2H- и H2D-копии на каждый элемент. С момента, когда GPU-транспорт стал opt-in, это единственный способ его получить на одном узле.
- **`cuda_vmm`** — только валидированные MNNVL-модели на GB200/GB300 с смонтированным IMEX-каналом и `--pp-size 1`.
- **Не задавайте `cuda_ipc` вручную** на многоузловом развертывании — это ошибка старта, а не деградация.
- **Не рассчитывайте** транспортом изменить размер признаков: их объем задают `--mm-process-config` и `--limit-mm-data-per-request`.

## Влияние на производительность и память

- **VRAM.** `cuda_ipc`/`cuda_vmm` резервируют `SGLANG_MM_FEATURE_CACHE_MB` (1 ГиБ по умолчанию) на `--base-gpu-id`. Резерв делается до профилирования KV-пула, поэтому он вычитается из `max_total_num_tokens` напрямую. `cpu` не занимает VRAM вообще — и именно поэтому он стал авто-выбором на одном узле.
- **RAM хоста и `/dev/shm`.** При `cpu` каждый признак в полете живет в сегменте `/dev/shm` (по умолчанию tmpfs = половина RAM). Переполнение tmpfs даст `OSError` при создании сегмента, и транспорт откатится на inline-передачу.
- **Дополнительный расход RAM у `cuda_vmm`.** Процессный пул препроцессинга (`ProcessPoolExecutor`, `SGLANG_CPU_WORKERS` процессов) при `cuda_vmm` создается со стартовым методом `spawn` вместо `fork`. Каждый процесс заново импортирует Python и torch — это и дольше на старте, и заметно дороже по RAM, чем fork с copy-on-write.
- **Латентность.** `cuda_ipc` убирает пару копий D2H/H2D на элемент, что заметно на крупных признаках и почти незаметно на мелких.
- **Стабильность расхода.** Пул ограничен, промах падает в CPU-путь; поэтому HBM-потребление транспорта постоянно и не зависит от бурста.

## Взаимодействие с другими аргументами

- `--keep-mm-feature-on-device`: устаревший предшественник; включенным он форсирует `cuda_ipc`, а несовместимое явное значение приводит к `ValueError`.
- `--tokenizer-worker-num`: делит бюджет пула, а не умножает его; при большом числе воркеров доля каждого мельчает и промахи учащаются.
- `--base-gpu-id`: пул всегда создается именно на этой карте, даже если tokenizer-воркеров несколько.
- `--nnodes`, `--dist-init-addr`: `cuda_ipc` требует одного узла; заданный `--dist-init-addr` переводит CPU-путь из `/dev/shm` в inline-передачу.
- `--pp-size`: `cuda_vmm` работает только при `pp_size == 1`.
- `--disaggregation-mode`, `--encoder-only`, `--encoder-transfer-backend`: при disaggregation авто-выбор дает `cpu`; в encoder-only режиме выход энкодера едет по `--encoder-transfer-backend`, а GPU-транспорт принудительно опускается до `cpu`.
- `--mem-fraction-static`: резерв пула уменьшает то, что достанется KV-кешу. Если вы включаете `cuda_ipc` на тесной карте, KV-пул надо пересчитать.
- В arriero этот гигабайт входит в фактический VRAM-draw инстанса и должен быть учтен в `config/resources.json` (`docs/RESOURCE_MANAGEMENT.md`). Сюрприза по умолчанию больше нет: пул появляется только при явном `cuda_ipc`/`cuda_vmm`, зато при его включении draw надо пересчитать.

## Типовые проблемы и диагностика

- `ValueError: --mm-feature-transport=cuda_ipc only supports a single node.` — многоузловое развертывание.
- `ValueError: --mm-feature-transport=cuda_vmm does not support pipeline parallelism.` / `... requires NVIDIA CUDA.` / `... is not supported with SGLANG_RUST_SERVER.` — проверки VMM-пути.
- `ValueError: --keep-mm-feature-on-device conflicts with --mm-feature-transport=cpu.` — заданы оба, и они противоречат друг другу.
- Пропал гигабайт VRAM на карте `--base-gpu-id` — значит `cuda_ipc` задан явно (сам по себе он на одном узле больше не включается). Подтверждение в логе: `Using CUDA IPC for multimodal features: reserving up to 1024 MiB on base GPU 0 across N tokenizer worker(s). This reduces KV cache headroom; a full pool falls back to CPU transport.`
- `MmItemMemoryPool has no free chunk large enough ...` — пул мал для ваших признаков; либо поднимайте `SGLANG_MM_FEATURE_CACHE_MB`, либо уменьшайте `--mm-process-config`, либо переходите на `cpu`.
- `OSError` с ENOSPC при создании сегмента — переполнен `/dev/shm`; увеличьте tmpfs или уменьшите число одновременно обрабатываемых элементов.
- Строки `Multimodal feature transport auto-resolved to ...` печатаются не всегда: самый частый случай (одноузловое CUDA ⇒ `cpu`) проходит молча. Лог есть у `cuda_vmm`, у отказа от него («the model has not opted into CUDA VMM transport», «no IMEX channel is mounted») и у encoder-only. Итоговое значение поля всегда видно в дампе `server_args=` — на него и ориентируйтесь.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-feature-transport cpu --mem-fraction-static 0.9
```

```bash
SGLANG_MM_FEATURE_CACHE_MB=2048 python -m sglang.launch_server --model-path /models/Qwen3-VL-30B-A3B-Instruct --mm-feature-transport cuda_ipc --tokenizer-worker-num 2 --base-gpu-id 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/transport/cuda_ipc.py`
- `sglang/python/sglang/srt/multimodal/transport/memory_pool.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/managers/mm_utils.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/cookbook/autoregressive/Moonshotai/Kimi-K3.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
