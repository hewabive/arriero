---
schema: 1
engine: sglang
primaryName: "--mm-feature-transport"
title: "--mm-feature-transport"
summary: Выбирает перенос мультимодальных признаков через CPU, одноузловой CUDA IPC или CUDA VMM с локальными/FABRIC-хендлами. По умолчанию используется `cpu`; `cuda_vmm` автоматически включается только для проверенной многоузловой конфигурации GB200/GB300 MNNVL с IMEX.
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
  - --mem-fraction-static
---

# --mm-feature-transport

## Кратко

Мультимодальный процессор создаёт `pixel_values`, `audio_features` и другие признаки в tokenizer-процессе, а scheduler должен получить их без неограниченного роста памяти. `cpu` переносит тензоры через RAM хоста; `cuda_ipc` кладёт их в ограниченный GPU-пул и передаёт обычные CUDA IPC-хендлы внутри одного узла; `cuda_vmm` экспортирует VMM-выделение как локальный POSIX FD или межузловой CUDA FABRIC handle.

Незаданный флаг теперь обычно означает `cpu`, в том числе на одноузловом CUDA-сервере. Единственный автоматический GPU-путь — `cuda_vmm` для мультимодальной модели на нескольких GB200/GB300 MNNVL-узлах, если доступен IMEX channel и класс модели явно поддерживает этот транспорт.

## Оригинальная справка

```text
Transport multimodal features through CPU memory, a bounded CUDA IPC pool, or a bounded CUDA VMM pool. Unset uses cpu except for validated multi-node GB200/GB300 MNNVL models, which use cuda_vmm when an IMEX channel is available. Select cuda_ipc explicitly for single-node GPU transport. GPU transports reserve SGLANG_MM_FEATURE_CACHE_MB (default 1024 MiB) on the base GPU and fall back to CPU transport when the pool is full.
```

## Паспорт аргумента

- Флаги: `--mm-feature-transport`
- Группа: `mm`
- Тип значения: `Optional[Literal["cpu", "cuda_ipc", "cuda_vmm"]]`
- Допустимые значения: `cpu`, `cuda_ipc`, `cuda_vmm`
- Значение по умолчанию: `null`; эффективное значение разрешает `ServerArgs._handle_multimodal_feature_transport`
- Где объявлен: `ServerArgs.mm_feature_transport`
- Этап применения: `__post_init__` → проверка поддержки модели в `TokenizerManager` → создание bounded pool → упаковка каждого мультимодального запроса

## Что меняет в движке

`_handle_multimodal_feature_transport` сначала переводит устаревший `--keep-mm-feature-on-device` и `SGLANG_USE_CUDA_IPC_TRANSPORT` в новую политику. Явный CLI-флаг имеет приоритет над конфликтующей переменной окружения. В `--encoder-only` оба GPU-варианта принудительно становятся `cpu`, потому что выход энкодера управляется `--encoder-transfer-backend`.

При незаданном значении движок выбирает:

- `cuda_vmm` только для мультимодальной конфигурации без disaggregation, `--nnodes > 1`, GB200/GB300 MNNVL, смонтированного `/dev/nvidia-caps-imex-channels/channel0` и модели с `supports_cuda_vmm_feature_transport = True`;
- `cpu` во всех остальных случаях, включая обычный одноузловой CUDA-сервер.

`cuda_ipc` создаёт по пулу на tokenizer-воркер, деля общий `SGLANG_MM_FEATURE_CACHE_MB` между ними. `cuda_vmm` также делит этот бюджет, но пакует тензоры запроса в экспортируемое VMM-выделение. На одном узле оно передаётся как POSIX FD; на нескольких узлах требуется CUDA FABRIC handle. Scheduler материализует VMM-прокси до обработки запроса, чтобы освобождение slice произошло даже при раннем отказе.

Если GPU-пул не вмещает признаки, конкретный запрос возвращается к CPU/inline-передаче. Это удерживает VRAM транспорта в фиксированном бюджете.

## Значения и формат

- `cpu` — перенос через host memory; на локальном пути возможен `/dev/shm`, на распределённом — inline ZMQ.
- `cuda_ipc` — только NVIDIA CUDA и `--nnodes 1`; выбирать его теперь нужно явно.
- `cuda_vmm` — только NVIDIA CUDA, `--pp-size 1`, без `SGLANG_RUST_SERVER`; модель должна явно поддерживать транспорт. В checkout это Kimi K2.5, Kimi K3 и Qwen3-VL.
- Размер обоих GPU-пулов задаёт `SGLANG_MM_FEATURE_CACHE_MB`, по умолчанию 1024 МиБ суммарно для tokenizer-воркеров на `--base-gpu-id` данного узла, а не на каждый воркер.
- `--mm-feature-transport cuda_vmm` можно задать явно и на одном узле: тогда разрешён POSIX FD вместо FABRIC.

## Когда использовать

- Оставляйте `cpu`, если карта близка к лимиту: GPU-транспорт отнимает фиксированный бюджет у весов и KV-cache.
- Выбирайте `cuda_ipc` на одном узле после измерения, когда D2H/H2D-копии крупных изображений или видео заметны в latency, а 1 ГиБ VRAM можно зарезервировать.
- Выбирайте `cuda_vmm` вручную только для поддерживаемой модели и подходящей CUDA driver/VMM-конфигурации. На многоузловом MNNVL обычно достаточно авторазрешения.
- Не используйте GPU-транспорт для encoder-only: аргумент не управляет передачей результата энкодера.

## Влияние на производительность и память

- `cuda_ipc` и `cuda_vmm` убирают промежуточные D2H/H2D-копии, но резервируют до `SGLANG_MM_FEATURE_CACHE_MB` на `--base-gpu-id`; эта VRAM больше не доступна KV-пулу.
- `cpu` не резервирует VRAM, зато увеличивает трафик host memory и давление на RAM/`/dev/shm`.
- Число tokenizer-воркеров не умножает бюджет: каждый получает `total // tokenizer_worker_num`, поэтому слишком много воркеров повышает вероятность pool miss.
- Полный GPU-пул деградирует потензорно в CPU-путь и не растёт вместе с конкурентностью.

## Взаимодействие с другими аргументами

- `--keep-mm-feature-on-device` — deprecated-предшественник `cuda_ipc`; конфликтует с явными `cpu` и `cuda_vmm`.
- `--nnodes`: `cuda_ipc` требует одного узла; многоузловой `cuda_vmm` требует MNNVL/FABRIC и IMEX.
- `--pp-size`: для `cuda_vmm` допустимо только `1`.
- `--tokenizer-worker-num` делит общий GPU-бюджет, `--base-gpu-id` выбирает карту-публикатор.
- `--mem-fraction-static`: GPU-пул создаёт дополнительное давление на VRAM и уменьшает запас для KV-cache.
- `--encoder-only` / `--encoder-transfer-backend`: первый отключает этот транспорт, второй выбирает реальную передачу encoder output.

## Типовые проблемы и диагностика

- `--mm-feature-transport=cuda_ipc only supports a single node` — используйте `cpu` или подходящий `cuda_vmm`.
- `--mm-feature-transport=cuda_vmm does not support pipeline parallelism` — верните `--pp-size 1`.
- `--mm-feature-transport=cuda_vmm is not supported by model class ...` — модель не имеет явного opt-in; используйте `cpu`/одноузловой `cuda_ipc`.
- Сообщение о полном пуле означает per-request fallback, а не утечку VRAM. Увеличьте `SGLANG_MM_FEATURE_CACHE_MB` или уменьшите мультимодальный payload.
- В старте ищите `Using CUDA IPC ...` либо `Using CUDA VMM ... with CUDA FABRIC/POSIX FD sharing`; итоговое значение видно в `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-feature-transport cpu
```

```bash
SGLANG_MM_FEATURE_CACHE_MB=2048 python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-feature-transport cuda_ipc --tokenizer-worker-num 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/cuda_ipc_transport_utils.py`
- `sglang/python/sglang/srt/utils/cuda_vmm_transport_utils.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
