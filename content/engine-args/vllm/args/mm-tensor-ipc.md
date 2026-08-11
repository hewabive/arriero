---
schema: 1
engine: vllm
primaryName: "--mm-tensor-ipc"
title: "--mm-tensor-ipc"
summary: Как мультимодальные тензоры доезжают из API-процесса в engine-процесс: сериализацией через RPC или через очередь torch.multiprocessing без копирования. Второй вариант работает только на одиночном движке (TP=PP=DP=1) и требует `VLLM_WORKER_MULTIPROC_METHOD=spawn`.
group: MultiModalConfig
related:
  - --mm-processor-device
  - --mm-processor-cache-type
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --data-parallel-size
  - --mm-encoder-only
  - --ec-transfer-config
---

# --mm-tensor-ipc

## Кратко

API-процесс (P0) препроцессирует медиа и должен передать результат в engine-процесс (P1). `direct_rpc` сериализует тензор msgspec'ом и шлёт по обычному RPC-каналу. `torch_shm` кладёт его в `torch.multiprocessing.Queue`, который делит память между процессами (а для device-тензоров — передаёт CUDA IPC handle), то есть копирования не происходит.

`torch_shm` — узкий режим: одна очередь идёт к рангу 0, поэтому любое распараллеливание (`TP`, `PP`, `DP` больше единицы) его запрещает, а метод порождения процессов должен быть `spawn`. Взамен он единственный, который позволяет мультимодальному процессору отдать тензор прямо с устройства (см. `--mm-processor-device`).

## Оригинальная справка

```text
IPC (inter-process communication) method for multimodal tensors.
- "direct_rpc": Use msgspec serialization via RPC
- "torch_shm": Use torch.multiprocessing shared memory for zero-copy IPC
Defaults to "direct_rpc". 
```

## Паспорт аргумента

- Флаги: `--mm-tensor-ipc`
- Группа argparse: `MultiModalConfig`
- Тип значения: enum (строка)
- Допустимые значения: `direct_rpc`, `torch_shm` (`MMTensorIPC`)
- Значение по умолчанию: `direct_rpc`
- Эффективное значение: не переопределяется молча — несовместимая конфигурация не откатывается к `direct_rpc`, а роняет старт с явной ошибкой
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_tensor_ipc`
- Этап применения: запуск процессов движка (создание очереди) → постпроцессинг результата HF-процессора → передача батча в engine core

## Что меняет в движке

**Создание транспорта.** `vllm/v1/engine/utils.py` при `mm_tensor_ipc == "torch_shm"` заводит один `Queue` из mp-контекста — комментарий в коде прямо говорит, что очередь одна, потому что поддерживается только DP=1. `MPClient` (`vllm/v1/engine/core_client.py`) оборачивает её в `TensorIpcSender` и передаёт `MsgpackEncoder` как `oob_tensor_consumer`: тензоры уходят мимо основного сообщения.

**Постпроцессинг процессора.** `InputProcessingContext._postprocess_output` (`vllm/multimodal/processing/context.py`) решает, оставлять ли результат на устройстве:

```python
keep_on_device = ... .mm_tensor_ipc == "torch_shm"
...
if not tensor.is_cpu and not keep_on_device:
    tensor = tensor.cpu()
```

То есть при `direct_rpc` любой device-тензор принудительно копируется на хост — иначе его нельзя сериализовать. Это и есть причина, по которой GPU-препроцессинг имеет смысл только вместе с `torch_shm`.

**Проверки на старте.**

- `ModelConfig`: `torch_shm` при `parallel_config.world_size_across_dp > 1` → `mm_tensor_ipc='torch_shm' is not supported with data_parallel_size > 1 or tensor_parallel_size > 1 or pipeline_parallel_size > 1.` Комментарий рядом объясняет: очередь идёт к рангу 0, а при DP API-сервер не знает, какому CoreEngine планировщик отдаст работу; при TP тензор пришлось бы рассылать всем рангам.
- `VllmConfig.__post_init__`: `torch_shm` при `VLLM_WORKER_MULTIPROC_METHOD != "spawn"` → `torch_shm is known to fail without VLLM_WORKER_MULTIPROC_METHOD set to spawn`.
- `VllmConfig._resolve_mm_processor_device`: на encode-only инстансе EPD-развёртки `auto` разрешается в акселератор только при `torch_shm`; иначе в лог уходит `EPD encoder instance: keeping the multi-modal processor on CPU because mm_tensor_ipc=direct_rpc cannot carry device tensors. Add --mm-tensor-ipc=torch_shm to run it on the accelerator.`

## Значения и формат

- `direct_rpc` — дефолт. Никаких ограничений по параллелизму и по методу запуска процессов.
- `torch_shm` — требует одновременно: `tensor_parallel_size == 1`, `pipeline_parallel_size == 1`, `data_parallel_size == 1` и `VLLM_WORKER_MULTIPROC_METHOD=spawn` (переменная окружения, не CLI-аргумент).
- Значение проверяется argparse по `choices`.
- Спецзначений нет; «выключить IPC» нельзя — процессы всё равно обмениваются данными.

## Когда использовать

- Одиночный GPU, тяжёлые медиа (видео, большие изображения), и профиль показывает, что сериализация тензора в API-процессе заметна: `torch_shm` убирает копирование.
- Encode-only инстанс разнесённой EPD-схемы, где хочется гонять препроцессинг на акселераторе: без `torch_shm` `--mm-processor-device` не даст эффекта.
- Оставайтесь на `direct_rpc` при любом параллелизме — это не рекомендация, а требование: `torch_shm` там просто не стартует.
- Не включайте `torch_shm` «на будущее»: если позже добавите `--tensor-parallel-size 2`, инстанс перестанет подниматься.

## Влияние на производительность и память

- **RAM хоста.** `direct_rpc` держит сериализованную копию тензора на время передачи; `torch_shm` — нет. На видео это сотни мегабайт пикового расхода в API-процессе.
- **VRAM.** Сам транспорт не выделяет память на устройстве. Косвенно `torch_shm` разрешает device-путь препроцессинга, и вот он VRAM уже расходует — бюджетируется отдельно через `--mm-ipc-gpu-memory-gb`.
- **Latency.** `torch_shm` убирает сериализацию/десериализацию из TTFT мультимодального запроса.
- **Throughput.** Растёт за счёт разгрузки CPU API-процесса.
- **Время старта.** Практически не меняется; добавляется создание очереди.
- **Устойчивость.** `torch_shm` — более хрупкий путь: он завязан на `spawn` и на конкретную топологию процессов, что апстрим фиксирует явными проверками.

## Взаимодействие с другими аргументами

- `--mm-processor-device`: `auto` разрешается в акселератор только при `torch_shm`; при `direct_rpc` результат всё равно копировался бы на хост, и выигрыш терялся.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--data-parallel-size`: любое значение > 1 несовместимо с `torch_shm`.
- `--mm-processor-cache-type`: решает другую задачу (переиспользование), но `shm`-кэш и `torch_shm`-транспорт дополняют друг друга — попадание в кэш вообще снимает передачу, промах при `torch_shm` передаётся без копии.
- `--mm-encoder-only`, `--ec-transfer-config`: контекст, в котором `torch_shm` чаще всего и нужен — encode-only инстанс.

## Типовые проблемы и диагностика

- **Симптом:** `mm_tensor_ipc='torch_shm' is not supported with data_parallel_size > 1 or tensor_parallel_size > 1 or pipeline_parallel_size > 1.` **Причина:** включён параллелизм. **Лечение:** вернуть `direct_rpc`.
- **Симптом:** `torch_shm is known to fail without VLLM_WORKER_MULTIPROC_METHOD set to spawn`. **Причина:** метод порождения процессов не `spawn`. **Лечение:** выставить переменную окружения в окружении инстанса.
- **Симптом:** `--mm-processor-device cuda` задан, а процессор остался на CPU. **Причина:** транспорт `direct_rpc`. **Проверка:** строка `EPD encoder instance: keeping the multi-modal processor on CPU because mm_tensor_ipc=direct_rpc cannot carry device tensors.` **Лечение:** добавить `--mm-tensor-ipc torch_shm`.
- **Симптом:** зависание при передаче крупного тензора после включения `torch_shm`. **Причина:** очередь `torch.multiprocessing` и file-descriptor-стратегия чувствительны к лимитам ОС (`ulimit -n`, размер `/dev/shm`). **Лечение:** проверить лимиты или вернуться на `direct_rpc`.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `mm_tensor_ipc=...`; отсутствие ошибок из списка выше означает, что режим принят.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-tensor-ipc torch_shm --limit-mm-per-prompt '{"video": 1}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-tensor-ipc direct_rpc --tensor-parallel-size 2
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/multimodal/processing/context.py`
- `vllm/vllm/v1/engine/core_client.py`
- `vllm/vllm/v1/engine/utils.py`
