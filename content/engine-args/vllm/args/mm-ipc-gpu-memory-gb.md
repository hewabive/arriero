---
schema: 1
engine: vllm
primaryName: "--mm-ipc-gpu-memory-gb"
title: "--mm-ipc-gpu-memory-gb"
summary: Квота VRAM для GPU-декодирования медиа в API-процессе. Она вычитается из уже посчитанного объёма KV-cache и работает как блокирующий семафор, поэтому включать её нужно вместе с GPU-бэкендом видео, а не «про запас».
group: MultiModalConfig
related:
  - --media-io-kwargs
  - --gpu-memory-utilization
  - --kv-cache-memory-bytes
  - --api-server-count
  - --mm-tensor-ipc
  - --mm-processor-device
---

# --mm-ipc-gpu-memory-gb

## Кратко

Если видео декодируется на GPU (NVDEC через PyNvVideoCodec или DeepStream), это происходит **в API-процессе**, вне памяти, которую движок себе профилировал. Две вещи, которые делает этот аргумент:

1. Резервирует заявленный объём: после профилирования он вычитается из `available_kv_cache_memory_bytes`, то есть headroom физически существует, а не подразумевается.
2. Создаёт блокирующий байтовый семафор в API-процессе: каждый GPU-декод берёт из пула ровно столько байт, сколько ему нужно под сырые кадры, и ждёт, если бюджет исчерпан. Конкурентные запросы выстраиваются в очередь, а не переподписывают карту.

Значение `0` (по умолчанию) отключает только gating. Резервирование под сами декодеры и CUDA-контекст при GPU-бэкенде видео происходит **независимо** от этого флага.

## Оригинальная справка

```text
Amount of GPU memory (in GiB) sequestered on the engine's device for
GPU-side multimodal work in the API-server (frontend) process, such as
hardware video decoding.

This budget is carved out of the engine's KV-cache memory so the headroom
physically exists, and frontend GPU decode paths acquire from a blocking
byte-counting semaphore of this size before allocating on the device.

Set to `0` (default) to disable frontend GPU multimodal memory gating.
```

## Паспорт аргумента

- Флаги: `--mm-ipc-gpu-memory-gb`
- Группа argparse: `MultiModalConfig`
- Тип значения: float, гибибайты
- Допустимые значения: `Field(default=0, ge=0)` — любое неотрицательное число
- Значение по умолчанию: `0` (gating выключен)
- Эффективное значение: пул одного API-процесса равен `int(значение × GiB) // api_process_count` — бюджет делится между API-процессами, а не умножается на их число
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_ipc_gpu_memory_gb`
- Этап применения: инициализация рендерера (создание пула в API-процессе) и `Worker.determine_available_memory()` (вычет из KV-cache)

## Что меняет в движке

**Пул в API-процессе.** `Renderer.__init__` вызывает `maybe_init_mm_gpu_ipc_pool(mm_ipc_gpu_memory_gb, api_process_count)`. При нуле пул не создаётся (`get_mm_gpu_ipc_pool()` возвращает `None`), и GPU-декод идёт без ограничения. Иначе в лог уходит `Initialized multimodal GPU IPC memory pool with N bytes for this API process (X.XX GiB total budget across M API process(es)).`

`MultiModalGPUMemoryPool` — байтовый семафор на `threading.Condition`: `acquire(nbytes)` блокируется, пока не освободится столько байт, `release` идемпотентен. Запрос больше полной ёмкости пула не «подождёт», а сразу упадёт: `Multimodal GPU decode requested N bytes, which exceeds the total pool size of M bytes. Increase --mm-ipc-gpu-memory-gb or reduce the multimodal input size.`

Реальный потребитель — `decode_frames_pynvvideocodec` (`vllm/multimodal/video.py`): он считает `len(frame_idx) × height × width × 3` байт под сырые кадры и берёт лизу на время декодирования.

**Вычет из KV-cache.** `reserve_mm_ipc_gpu_memory()` вызывается из `Worker.determine_available_memory()` на обеих ветках — и после профилирования, и на пути `--kv-cache-memory-bytes`. Резервируются две статьи:

- `raw_frame_reserved_bytes = mm_ipc_gpu_memory_gb × GiB` — общий бюджет сырых кадров, **не** умножается на число API-процессов, потому что он между ними делится;
- `decoder_reserved_bytes` — только при GPU-бэкенде видео: `(128 MiB × hw_decoders + 1.8 GiB CUDA-контекста) × api_process_count`. Эта статья не зависит от значения флага: каждый API-процесс держит свои декодерные поверхности и свой NVDEC/CUVID-контекст.

Если резерв не оставляет места, старт падает с `frontend multimodal GPU decoding reserves X GiB (... raw-frame budget, ... decoder cache budget), but only Y GiB is available for the KV cache. Reduce mm_ipc_gpu_memory_gb or hw_decoders, use a different video backend, or increase gpu_memory_utilization.` Успешный резерв печатается как `Reserving X GiB of GPU memory for frontend multimodal decoding (...); KV cache memory reduced to Y GiB.`

Признак «бэкенд видео на GPU» даёт `MultiModalConfig.use_gpu_video_backend()`: он смотрит `media_io_kwargs["video"]["video_backend"]`/`["backend"]` и переменную `VLLM_VIDEO_LOADER_BACKEND` и спрашивает у `VIDEO_LOADER_REGISTRY`, требует ли этот бэкенд GPU.

## Значения и формат

- Число в GiB, дробное допустимо (`--mm-ipc-gpu-memory-gb 1.5`).
- `0` — gating выключен: пул не создаётся, сырые кадры декодируются без ограничения по объёму. Резервирование под декодеры при GPU-бэкенде всё равно происходит.
- Отрицательные значения отвергает pydantic (`ge=0`).
- Значение — **общий** бюджет на все API-процессы: при `--api-server-count 2` каждому достанется половина.
- Ориентир для расчёта: один сырой кадр 1920×1080 RGB — около 6 MiB; 32 кадра — около 190 MiB на один запрос. Пул должен вмещать хотя бы один самый крупный ожидаемый декод, иначе будет не ожидание, а отказ.

## Когда использовать

- Включён GPU-декод видео (`--media-io-kwargs '{"video": {"video_backend": "pynvvideocodec"}}'` или соответствующее значение `VLLM_VIDEO_LOADER_BACKEND`) и на карте живёт та же модель: без квоты декод конкурирует за VRAM с KV-cache и даёт непредсказуемый OOM.
- Много параллельных видео-запросов: семафор превращает переподписку в очередь.
- Не задавайте, если видео декодируется на CPU (дефолтный `opencv`): резерв просто отнимет память у KV-cache без всякой пользы.
- Не подбирайте значение «поменьше, чтобы не жалко»: слишком маленький пул не замедляет работу, а роняет запрос с сообщением про превышение ёмкости.

## Влияние на производительность и память

- **VRAM.** Прямо уменьшает KV-cache на заявленный объём (плюс фиксированный резерв под декодеры при GPU-бэкенде). Механику общего бюджета см. в `--gpu-memory-utilization`.
- **Throughput.** Уменьшение KV-cache снижает `Maximum concurrency`; взамен исчезают OOM от нерегулируемого декодирования.
- **Latency.** При исчерпании пула запросы ждут на `acquire` — латентность растёт предсказуемо вместо падения по OOM.
- **RAM хоста.** Не влияет.
- **Время старта.** Не влияет; резервирование — это арифметика после профилирования.

## Взаимодействие с другими аргументами

- `--media-io-kwargs`: определяет, используется ли GPU-бэкенд видео (и значение `hw_decoders`, на которое умножается резерв декодерных поверхностей). Без GPU-бэкенда этот флаг резервирует память впустую.
- `--gpu-memory-utilization`: задаёт общий бюджет; резерв вычитается уже из результата профилирования, поэтому при тесном бюджете придётся поднимать utilization или снижать здесь.
- `--kv-cache-memory-bytes`: резерв применяется и на этом пути тоже — заданные вручную байты KV-cache уменьшатся на величину резерва.
- `--api-server-count`: делит бюджет сырых кадров между процессами и умножает резерв декодеров.
- `--mm-tensor-ipc`, `--mm-processor-device`: другой источник GPU-работы во фронтенде (препроцессинг на устройстве). Этим семафором он не ограничивается — пул гейтит именно пути декодирования медиа.

## Типовые проблемы и диагностика

- **Симптом:** `frontend multimodal GPU decoding reserves X GiB ..., but only Y GiB is available for the KV cache.` **Причина:** резерв больше, чем осталось после весов и активаций. **Лечение:** уменьшить значение или `hw_decoders`, перейти на CPU-бэкенд видео, поднять `--gpu-memory-utilization`.
- **Симптом:** `Multimodal GPU decode requested N bytes, which exceeds the total pool size of M bytes.` **Причина:** один запрос требует больше, чем весь пул. **Лечение:** поднять значение либо уменьшить число кадров/разрешение через `--media-io-kwargs`.
- **Симптом:** случайные OOM на карте при видео-нагрузке, при том что KV-cache стабилен. **Причина:** GPU-декод без gating. **Лечение:** задать ненулевой бюджет.
- **Симптом:** KV-cache уменьшился на ~2 GiB, хотя флаг равен нулю. **Причина:** резерв под декодерные поверхности и CUDA-контекст NVDEC, который применяется при любом GPU-бэкенде видео. **Проверка:** строка `Reserving X GiB of GPU memory for frontend multimodal decoding (0.00 GiB raw-frame semaphore budget, ... GiB decoder+CUDA-context ...)`.
- **Симптом:** запросы стали ждать. **Причина:** пул исчерпан, `acquire` блокирует. **Лечение:** увеличить бюджет либо ограничить параллелизм на стороне клиента.
- **Подтверждение принятого значения:** строки `Initialized multimodal GPU IPC memory pool with N bytes ...` (API-процесс) и `Reserving X GiB of GPU memory for frontend multimodal decoding ...; KV cache memory reduced to Y GiB.` (worker).

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --media-io-kwargs '{"video": {"video_backend": "pynvvideocodec"}}' --mm-ipc-gpu-memory-gb 2 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --media-io-kwargs '{"video": {"video_backend": "pynvvideocodec", "hw_decoders": 1}}' --mm-ipc-gpu-memory-gb 1 --api-server-count 2
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/gpu_ipc_memory.py`
- `vllm/vllm/multimodal/video.py`
- `vllm/vllm/renderers/base.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
