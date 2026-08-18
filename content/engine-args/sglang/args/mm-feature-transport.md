---
schema: 1
engine: sglang
primaryName: "--mm-feature-transport"
title: "--mm-feature-transport"
summary: Как признаки мультимодальных данных едут из tokenizer-процесса в scheduler: через RAM хоста и `/dev/shm` или через ограниченный CUDA IPC-пул на GPU. На одноузловом CUDA-развертывании без disaggregation незаданное значение авто-разрешается в `cuda_ipc`, который резервирует фиксированный кусок VRAM на базовой карте; отказаться — явным `cpu`.
group: mm
related:
  - --keep-mm-feature-on-device
  - --tokenizer-worker-num
  - --base-gpu-id
  - --nnodes
  - --disaggregation-mode
  - --encoder-only
  - --encoder-transfer-backend
  - --dist-init-addr
  - --enable-multimodal
  - --mem-fraction-static
---

# --mm-feature-transport

## Кратко

Мультимодальные признаки (`pixel_values` и родня) рождаются в tokenizer-процессе, а нужны в процессе scheduler'а. `--mm-feature-transport` выбирает, как они туда попадают: `cpu` — копия в RAM хоста и передача через сегмент `/dev/shm`; `cuda_ipc` — тензор остается на GPU в **ограниченном** пуле и передается по CUDA IPC-хендлу.

Не задан — движок выбирает сам: одноузловое CUDA-развертывание без disaggregation получает `cuda_ipc` (в лог уходит `Multimodal feature transport auto-resolved to cuda_ipc (single-node CUDA). Pass --mm-feature-transport=cpu to opt out.`), все остальное — `cpu`. То есть по умолчанию на типичной одноузловой мультимодальной конфигурации на базовой карте резервируется пул `SGLANG_MM_FEATURE_CACHE_MB` (1024 МиБ). Пул создается только когда у модели есть мультимодальный процессор — чисто текстовые развертывания не платят ничего. Переполненный пул деградирует потензорно в CPU-путь, так что расход HBM ограничен сверху.

## Оригинальная справка

```text
Transport multimodal features through CPU memory or a bounded CUDA IPC pool. Unset resolves automatically: single-node CUDA deployments (without disaggregation) use cuda_ipc, everything else uses cpu. CUDA IPC reserves SGLANG_MM_FEATURE_CACHE_MB (default 1024 MiB) on the base GPU and falls back to CPU transport per tensor when the pool is full.
```

## Паспорт аргумента

- Флаги: `--mm-feature-transport`
- Группа: `mm`
- Тип значения: строка; поле объявлено как `Optional[Literal["cpu", "cuda_ipc"]]`, choices выводятся из `Literal`
- Допустимые значения: `cpu`, `cuda_ipc`
- Значение по умолчанию: `null` — «подобрать по развертыванию»
- Эффективное значение: целиком определяется методом `ServerArgs._handle_multimodal_feature_transport`; после него поле всегда содержит одну из двух строк, а `keep_mm_feature_on_device` принудительно сбрасывается в `False`
- Где объявлен: `ServerArgs.mm_feature_transport`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (до запуска tokenizer-воркеров) → конструирование процессора и выделение GPU-пула → каждый запрос с мультимодальными данными

## Что меняет в движке

### Разрешение значения

`_handle_multimodal_feature_transport` выполняется до старта воркеров и разбирает случаи в следующем порядке:

1. Задан устаревший `--keep-mm-feature-on-device` — транспорт принудительно становится `cuda_ipc` с предупреждением; явный `--mm-feature-transport cpu` рядом с ним — `ValueError`.
2. Значение не задано:
   - выставлена устаревшая переменная `SGLANG_USE_CUDA_IPC_TRANSPORT` — берется `cuda_ipc`/`cpu` по ней, с предупреждением;
   - `--encoder-only` — `cpu` (выход энкодера едет по `--encoder-transfer-backend`, а не по этому транспорту);
   - платформа CUDA, `--nnodes 1`, `--disaggregation-mode null` ⇒ `cuda_ipc`, с info-строкой про opt-out;
   - всё остальное (многоузловое развертывание — IPC-хендлы работают только внутри узла, PD-disaggregation, не-CUDA) ⇒ `cpu`.
3. Значение задано явно, но конфликтует с устаревшей переменной окружения — печатается предупреждение, побеждает аргумент.
4. `--encoder-only` вместе с `cuda_ipc` — транспорт принудительно опускается до `cpu` с предупреждением.

Затем жесткие проверки для `cuda_ipc`: требует CUDA (`ValueError: --mm-feature-transport=cuda_ipc requires NVIDIA CUDA.`) и **строго один узел** (`ValueError: --mm-feature-transport=cuda_ipc only supports a single node.`).

В конце метод пишет `envs.SGLANG_USE_CUDA_IPC_TRANSPORT` в `1`/`0` — переменная окружения становится следствием аргумента, а не наоборот. Docstring метода фиксирует и мотив ограниченного пула: он живет на `base_gpu_id` и уменьшает память, доступную весам и KV-кешу, поэтому его бюджет — жесткая константа, не зависящая от трафика.

### Где физически лежат признаки

- **`cpu`.** После вызова процессора все тензоры из `FEATURE_NAMES` (`pixel_values`, `pixel_values_videos`, `audio_features`, `input_features`) переносятся на CPU. Дальше, если развертывание одноузловое, каждый такой тензор оборачивается в `ShmPointerMMData` (`managers/mm_utils.py`): создается отдельный сегмент `/dev/shm`, страницы резервируются `posix_fallocate` (чтобы переполнение tmpfs давало ловимую `OSError: ENOSPC`, а не `SIGBUS` посреди копирования), и в scheduler едет только имя сегмента. При заданном `--dist-init-addr` режим транспорта становится `default`, и тензоры пикулятся прямо в сообщение ZMQ.
- **`cuda_ipc`.** Каждый tokenizer-воркер создает на `cuda:<base_gpu_id>` свой `MmItemMemoryPool` (`utils/cuda_ipc_transport_utils.py`): общий бюджет `SGLANG_MM_FEATURE_CACHE_MB` (по умолчанию 1024 МиБ) **делится нацело** между воркерами, `total // tokenizer_worker_num` на каждого, — так что число воркеров не умножает резерв. Каждый признак копируется в свободный chunk пула, а в scheduler едет IPC-хендл со смещением; занятые chunk'и перерабатываются по sync-флагу с периодом `SGLANG_MM_ITEM_MEM_POOL_RECYCLE_INTERVAL_SEC` (0.05 с), соседние свободные — сливаются.

### Что происходит при переполнении GPU-пула

Если свободного chunk'а нужного размера нет, тензор едет обычным (CPU) путем. Один раз на процесс печатается предупреждение:

```text
MmItemMemoryPool has no free chunk large enough for a X MiB tensor (pool size: Y MiB); falling back to non-IPC transport. Consider increasing SGLANG_MM_FEATURE_CACHE_MB.
```

Это принципиально: пул **ограничен**, поэтому расход HBM не зависит от нагрузки. По той же причине `keep_mm_feature_on_device` принудительно сбрасывается — иначе после промаха пула тензоры оставались бы на устройстве вне пула, и потребление HBM стало бы функцией трафика.

## Значения и формат

- Ровно одна строка из двух; argparse отвергает остальное как `invalid choice`.
- Отсутствие аргумента на одноузловом CUDA-развертывании без disaggregation эквивалентно `cuda_ipc`; на всех остальных — `cpu`. Отказ от пула — только явным `--mm-feature-transport cpu`.
- `cuda_ipc` несовместим с `--nnodes > 1` и с не-CUDA платформами — это ошибка старта.
- Размер пула этим аргументом не задается — только переменной `SGLANG_MM_FEATURE_CACHE_MB` (в МиБ, суммарно на узел, а не на воркер).
- Кеширование pool-хендлов на стороне потребителя включено по умолчанию и отключается `SGLANG_USE_IPC_POOL_HANDLE_CACHE=0`; оно переиспользует отображения существующего пула и **не** резервирует второй пул.

## Когда использовать

- **`cpu` явно** — тесная карта, где гигабайт пула ощутим для KV-кеша, или желание закрепить поведение в конфиге независимо от политики авто-выбора. Апстрим-рецепты (Kimi-K3) используют оба явных значения именно как фиксацию.
- **Ничего не задавать или `cuda_ipc` явно** — одноузловое развертывание, VRAM в достатке, признаки крупные (высокое разрешение, видео): исчезают D2H- и H2D-копии на каждый элемент.
- **Не задавайте `cuda_ipc` вручную** на многоузловом развертывании — это ошибка старта, а не деградация.
- **Не рассчитывайте** транспортом изменить размер признаков: их объем задают `--mm-process-config` и `--limit-mm-data-per-request`.

## Влияние на производительность и память

- **VRAM.** `cuda_ipc` резервирует `SGLANG_MM_FEATURE_CACHE_MB` (1 ГиБ по умолчанию) на `--base-gpu-id` — и на одноузловом CUDA он включен по умолчанию у любой мультимодальной модели. Резерв делается до профилирования KV-пула, поэтому он вычитается из `max_total_num_tokens` напрямую. `cpu` не занимает VRAM вообще.
- **RAM хоста и `/dev/shm`.** При `cpu` каждый признак в полете живет в сегменте `/dev/shm` (по умолчанию tmpfs = половина RAM). Переполнение tmpfs даст ловимую ошибку при создании сегмента, и конкретный тензор откатится на inline-передачу с предупреждением `Failed to allocate shared memory for multimodal feature transport …; falling back to inline transport.`
- **Латентность.** `cuda_ipc` убирает пару копий D2H/H2D на элемент, что заметно на крупных признаках и почти незаметно на мелких.
- **Стабильность расхода.** Пул ограничен, промах падает в CPU-путь; поэтому HBM-потребление транспорта постоянно и не зависит от бурста.

## Взаимодействие с другими аргументами

- `--keep-mm-feature-on-device`: устаревший предшественник; включенным он форсирует `cuda_ipc`, а явный `cpu` рядом с ним — `ValueError`.
- `--tokenizer-worker-num`: делит бюджет пула, а не умножает его; при большом числе воркеров доля каждого мельчает и промахи учащаются.
- `--base-gpu-id`: пулы всех tokenizer-воркеров создаются именно на этой карте.
- `--nnodes`, `--dist-init-addr`: `cuda_ipc` требует одного узла; заданный `--dist-init-addr` переводит CPU-путь из `/dev/shm` в inline-передачу.
- `--disaggregation-mode`, `--encoder-only`, `--encoder-transfer-backend`: при disaggregation авто-выбор дает `cpu`; в encoder-only режиме выход энкодера едет по `--encoder-transfer-backend`, а `cuda_ipc` принудительно опускается до `cpu`.
- `--mem-fraction-static`: резерв пула уменьшает то, что достанется KV-кешу.
- В arriero этот гигабайт по умолчанию входит в фактический VRAM-draw одноузлового мультимодального инстанса и должен быть учтен в `config/resources.json` (`docs/RESOURCE_MANAGEMENT.md`); экономящий VRAM вариант — явный `cpu` в аргументах инстанса.

## Типовые проблемы и диагностика

- `ValueError: --mm-feature-transport=cuda_ipc only supports a single node.` — многоузловое развертывание.
- `ValueError: --mm-feature-transport=cuda_ipc requires NVIDIA CUDA.` — не-CUDA платформа.
- `ValueError: --keep-mm-feature-on-device conflicts with --mm-feature-transport=cpu. Use only --mm-feature-transport=cuda_ipc.` — заданы оба, и они противоречат друг другу.
- Пропал гигабайт VRAM на карте `--base-gpu-id` у мультимодальной модели — это пул транспорта, включенный авто-выбором. Подтверждение в логе: `Using CUDA IPC for multimodal features: reserving up to 1024 MiB on base GPU 0 across N tokenizer worker(s). This reduces KV cache headroom; a full pool falls back to CPU transport.` и, от каждого процессора, `CUDA IPC multimodal feature pools reserve … MiB total on GPU …`. Лечение — явный `--mm-feature-transport cpu`.
- `MmItemMemoryPool has no free chunk large enough …` — пул мал для ваших признаков; либо поднимайте `SGLANG_MM_FEATURE_CACHE_MB`, либо уменьшайте `--mm-process-config`, либо переходите на `cpu`.
- `Failed to allocate shared memory …` — переполнен `/dev/shm`; увеличьте tmpfs или уменьшите число одновременно обрабатываемых элементов.
- Итоговое значение поля всегда видно в дампе `server_args=` — на него и ориентируйтесь; авто-выбор `cpu` на не подпадающих под `cuda_ipc` конфигурациях проходит без отдельной строки в логе.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-feature-transport cpu --mem-fraction-static 0.9
```

```bash
SGLANG_MM_FEATURE_CACHE_MB=2048 python -m sglang.launch_server --model-path /models/Qwen3-VL-30B-A3B-Instruct --mm-feature-transport cuda_ipc --tokenizer-worker-num 2 --base-gpu-id 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/cuda_ipc_transport_utils.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/managers/mm_utils.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/cookbook/autoregressive/Moonshotai/Kimi-K3.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
