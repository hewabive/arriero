---
schema: 1
engine: vllm
primaryName: "--media-io-kwargs"
title: "--media-io-kwargs"
summary: Параметры загрузки и декодирования медиа по модальностям — число кадров видео, fps, бэкенд декодера, фон для RGBA. Именно здесь выбирается GPU-декод видео, а это меняет резервирование VRAM ещё до KV-cache.
group: MultiModalConfig
related:
  - --mm-processor-kwargs
  - --mm-ipc-gpu-memory-gb
  - --limit-mm-per-prompt
  - --allowed-local-media-path
  - --allowed-media-domains
  - --gpu-memory-utilization
  - --trust-request-mm-kwargs
---

# --media-io-kwargs

## Кратко

Это слой **до** HF-процессора: как байты превратились в кадры и пиксели. Ключ верхнего уровня — модальность (`video`, `image`, `audio`), значение — словарь, который уходит в соответствующий `MediaIO`-класс.

Практически важны две вещи. Во-первых, `{"video": {"num_frames": N}}` — самый прямой способ сократить число визуальных токенов на видео. Во-вторых, `video_backend`/`backend` выбирают декодер: если выбранный требует GPU, движок при старте зарезервирует VRAM под декодерные поверхности и CUDA-контекст NVDEC, уменьшив KV-cache — независимо от того, задан ли `--mm-ipc-gpu-memory-gb`.

## Оригинальная справка

```text
Additional args passed to process media inputs, keyed by modalities.
For example, to set num_frames for video, set
`--media-io-kwargs '{"video": {"num_frames": 40} }'`
```

## Паспорт аргумента

- Флаги: `--media-io-kwargs`
- Группа argparse: `MultiModalConfig`
- Тип значения: JSON-объект `{модальность: {ключ: значение}}`
- Допустимые значения: ключи модальностей и их параметры определяются классами `MediaIO`; движок их не ограничивает
- Значение по умолчанию: `Field(default_factory=dict)` — пустой словарь
- Эффективное значение: при `--trust-request-mm-kwargs` сливается с per-request `media_io_kwargs` через `merge_media_io_kwargs` (без этого флага запрос с непустым `media_io_kwargs` отвергается); отдельные модели правят словарь сами (например `vllm/model_executor/models/config.py` доопределяет `media_io_kwargs["video"]`)
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.media_io_kwargs`
- Этап применения: расчёт резерва VRAM под GPU-декод (worker) → загрузка каждого медиа-элемента в API-процессе

## Что меняет в движке

**Куда попадают значения.** `MediaConnector` строит per-modality IO-классы: `ImageMediaIO(image_mode=..., **kwargs)`, `VideoMediaIO(image_io, num_frames=..., **kwargs)`, `AudioMediaIO(**kwargs)`. Всё, что не разобрано явно, остаётся в `self.kwargs` и передаётся загрузчику.

Разобранные явно параметры видео (`vllm/multimodal/media/video.py`):

- `num_frames` — сколько кадров сэмплировать (по умолчанию 32); `-1` означает «все»;
- `fps` — частота сэмплирования; взаимодействует с `num_frames`;
- `video_backend` — имя загрузчика из `VIDEO_LOADER_REGISTRY` (значение по умолчанию берётся из переменной окружения `VLLM_VIDEO_LOADER_BACKEND`, дефолт `opencv`);
- `backend` — кодек;
- `hw_decoders` — число аппаратных декодеров для `pynvvideocodec` (по умолчанию 2);
- `total_num_frames` — для jpeg-последовательностей.

Для изображений в `ImageMediaIO` разобран `rgba_background_color` (по умолчанию белый) и `image_mode`.

Реальный перечень зарегистрированных бэкендов видео смотрите по декораторам `@VIDEO_LOADER_REGISTRY.register(...)` в `vllm/multimodal/video.py` установленной версии — он расширяется от релиза к релизу и включает как общие (`opencv`, `pynvvideocodec`), так и модель-специфичные загрузчики.

**Резервирование VRAM.** `MultiModalConfig.use_gpu_video_backend()` спрашивает у реестра, требует ли выбранный бэкенд GPU. Если да, `reserve_mm_ipc_gpu_memory()` вычитает из KV-cache `(128 MiB × hw_decoders + 1.8 GiB CUDA-контекста) × api_process_count`, плюс бюджет сырых кадров из `--mm-ipc-gpu-memory-gb`. Это происходит при старте, до того как KV-cache превратится в блоки.

**Слияние с запросом.** Протоколы chat completions, responses и pooling объявляют поле `media_io_kwargs`, но по умолчанию непустое значение отвергается с HTTP 400 (`Per-request media_io_kwargs are disabled by default ...`). Только при `--trust-request-mm-kwargs` `merge_media_io_kwargs` объединяет его с engine-уровнем по модальностям, вызывая `merge_kwargs` конкретного IO-класса. `VideoMediaIO.merge_kwargs` дополнительно защищается:

- выкидывает из запроса `hw_decoders` и `pool_size` — VRAM под них зарезервирована на старте;
- выкидывает `video_backend`/`backend`, если запрошенный требует GPU, а на старте был настроен другой (`Stripping request-level video_backend=...: GPU video backend not configured at startup.`);
- разрешает конфликт `fps`/`num_frames`: если в запросе пришло одно, второе вычищается из дефолтов.

## Значения и формат

Обе формы записи допустимы:

```bash
--media-io-kwargs '{"video": {"num_frames": 40}}'
--media-io-kwargs.video.num_frames 40
```

- Пустой словарь (дефолт) — параметры по умолчанию каждого IO-класса.
- `num_frames: -1` — брать все кадры; `0` отвергается (`num_frames must be greater than 0 or -1`).
- Неизвестный ключ не даёт ошибки конфигурации: он просто уедет в `**kwargs` загрузчика и может быть проигнорирован. Проверять надо по коду конкретного загрузчика.
- Ключи модальностей, которых у модели нет, безвредны.

## Когда использовать

- Видео-нагрузка: `{"video": {"num_frames": 16}}` кратно сокращает число визуальных токенов, длину промпта и время prefill. Это первое, что стоит настроить на VL-модели с видео.
- Аппаратный декод: `{"video": {"video_backend": "pynvvideocodec"}}` снимает декодирование с CPU. Учитывайте резерв VRAM и задавайте `--mm-ipc-gpu-memory-gb`.
- Прозрачные PNG: `{"image": {"rgba_background_color": [0, 0, 0]}}`, если белая подложка по умолчанию портит вход.
- Не используйте для параметров HF-процессора (`num_crops`, границы пикселей) — это `--mm-processor-kwargs`.
- Клиент не может переопределить эти значения, пока не включен `--trust-request-mm-kwargs`. С ним per-request `media_io_kwargs` принимаются, и от переопределения защищены только GPU-специфичные ключи.

## Влияние на производительность и память

- **VRAM.** Косвенно, но сильно: выбор GPU-бэкенда включает фиксированный резерв (порядка 2 GiB на API-процесс при дефолтных `hw_decoders`), который вычитается из KV-cache. `num_frames` определяет число визуальных токенов, то есть расход KV-cache на запрос и занятость encoder cache.
- **CPU хоста.** CPU-декодеры (`opencv`) грузят API-процесс; аппаратный декод переносит работу на NVDEC.
- **Latency.** `num_frames` — доминирующий множитель TTFT на видео.
- **Время старта.** Не влияет напрямую; влияет только через величину резерва.
- **RAM хоста.** Больше кадров — крупнее промежуточные массивы и крупнее элемент кэша препроцессора (см. `--mm-shm-cache-max-object-size-mb`).

## Взаимодействие с другими аргументами

- `--mm-processor-kwargs`: следующий слой обработки; разделение — «декодирование» против «препроцессинга».
- `--mm-ipc-gpu-memory-gb`: имеет смысл только если здесь выбран GPU-бэкенд видео; вместе они и определяют полный резерв.
- `--limit-mm-per-prompt`: подсказки размера там влияют на профилирование, а реальную геометрию входа задаёт этот аргумент. Расхождение между ними — типичная причина, когда профилирование «промахивается» мимо реальной нагрузки.
- `--gpu-memory-utilization`: резерв под декодеры вычитается уже из результата профилирования.
- `--allowed-local-media-path`, `--allowed-media-domains`: определяют, откуда медиа вообще можно загрузить; этот аргумент — что с ним делать после загрузки.
- `--mm-shm-cache-max-object-size-mb`: число кадров прямо определяет, влезет ли элемент в лимит объекта shm-кэша.
- `--trust-request-mm-kwargs`: разрешает клиенту присылать свои `media_io_kwargs` поверх серверных; по умолчанию выключен.

## Типовые проблемы и диагностика

- **Симптом:** KV-cache внезапно уменьшился примерно на 2 GiB. **Причина:** выбран GPU-бэкенд видео, зарезервированы декодерные поверхности и CUDA-контекст. **Проверка:** строка `Reserving X GiB of GPU memory for frontend multimodal decoding (... GiB decoder+CUDA-context across N API server(s) @ Y GiB/server); KV cache memory reduced to Z GiB.`
- **Симптом:** `frontend multimodal GPU decoding reserves ... but only ... is available for the KV cache.` **Причина:** резерв не помещается. **Лечение:** уменьшить `hw_decoders`, вернуться на CPU-бэкенд, поднять `--gpu-memory-utilization`.
- **Симптом:** предупреждение `Stripping request-level video_backend=...: GPU video backend not configured at startup.` **Причина:** при включенном `--trust-request-mm-kwargs` клиент попросил GPU-декодер, не настроенный на старте. **Лечение:** задать бэкенд в этом аргументе при запуске.
- **Симптом:** клиент получает 400 `Per-request media_io_kwargs are disabled by default ...`. **Причина:** per-request `media_io_kwargs` без `--trust-request-mm-kwargs`. **Лечение:** перенести значение в этот флаг или, для доверенных клиентов, включить `--trust-request-mm-kwargs`.
- **Симптом:** `num_frames must be greater than 0 or -1`. **Причина:** передан `0`. **Лечение:** положительное число или `-1`.
- **Симптом:** видео сжирает весь контекст. **Причина:** дефолтные 32 кадра при высоком разрешении. **Лечение:** снизить `num_frames` и/или ограничить разрешение через `--mm-processor-kwargs`.
- **Подтверждение принятого значения:** словарь виден в стартовой строке конфига как `media_io_kwargs={...}`; для GPU-бэкенда — упомянутая строка про резервирование.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --media-io-kwargs '{"video": {"num_frames": 16}}' --limit-mm-per-prompt '{"video": 1, "image": 0}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --media-io-kwargs '{"video": {"video_backend": "pynvvideocodec", "hw_decoders": 1, "num_frames": 32}}' --mm-ipc-gpu-memory-gb 2 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/media/video.py`
- `vllm/vllm/multimodal/media/image.py`
- `vllm/vllm/multimodal/media/audio.py`
- `vllm/vllm/multimodal/media/connector.py`
- `vllm/vllm/multimodal/video.py`
- `vllm/vllm/multimodal/gpu_ipc_memory.py`
- `vllm/vllm/renderers/params.py`
- `vllm/vllm/entrypoints/generate/base/protocol.py`
