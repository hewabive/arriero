---
schema: 1
engine: sglang
primaryName: "--image-processor-backend"
title: "--image-processor-backend"
summary: Выбирает реализацию препроцессинга изображений — `torchvision` (быстрый, умеет считать на GPU) или `pil` (медленный CPU-путь, зато совместимый). Пришел на смену `--disable-fast-image-processor`, где то же самое переключалось булевым флагом.
group: mm
related:
  - --disable-fast-image-processor
  - --mm-process-config
  - --mm-feature-transport
  - --enable-mm-global-cache
  - --base-gpu-id
  - --encoder-only
  - --rl-on-policy-target
---

# --image-processor-backend

## Кратко

Мультимодальный запрос перед forward'ом проходит препроцессинг картинок: decode, resize, нормализация, нарезка на патчи. Transformers умеет делать это двумя способами — старым на PIL/NumPy и быстрым на `torchvision`, который вдобавок способен считать прямо на GPU. Этот аргумент выбирает способ явно.

Он заменил булев `--disable-fast-image-processor`: тот выражал ровно две точки из трех (`pil` или «как решит Transformers»), а `torchvision` потребовать было нельзя. Старый флаг работает, но помечен deprecated и просто переписывается в `--image-processor-backend=pil`.

Практический эффект `pil` шире, чем «другая библиотека»: на этом backend'е препроцессинг **никогда не уезжает на GPU**, потому что `device` в вызов процессора подставляется только для не-`pil` пути.

## Оригинальная справка

```text
Image processor backend. 'auto' lets Transformers select the best available backend.
```

## Паспорт аргумента

- Флаги: `--image-processor-backend`
- Группа: `mm`
- Тип значения: строка, объявлена как `Literal["auto", "torchvision", "pil"]`
- Допустимые значения: `auto`, `torchvision`, `pil`
- Значение по умолчанию: `auto`
- Эффективное значение: `pil`, если задан устаревший `--disable-fast-image-processor` (перезапись в `_handle_deprecated_args`, с предупреждением); в остальном — заданное значение как есть
- Где объявлен: `ServerArgs.image_processor_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (перезапись из deprecated-флага) → загрузка процессора в tokenizer-процессе → каждый вызов процессора на мультимодальном запросе

## Что меняет в движке

Значение читается через одну функцию `resolve_image_processor_backend(server_args)` (`utils/hf_transformers/processor.py`), которая заодно учитывает устаревший флаг. Ее вызывают `TokenizerManager`, `Scheduler` (процессор для фолбэка M-RoPE) и оба процесса EPD-схемы (`disaggregation/encode_server.py`, `encode_receiver.py`).

Внутри `get_processor` дальше происходит два шага:

1. `_normalize_image_processor_backend` сводит новый аргумент со старым параметром `use_fast`: `use_fast=True` означает `torchvision`, `use_fast=False` — `pil`, а несовместимая пара дает `ValueError: use_fast=... conflicts with image_processor_backend=...`.
2. `_apply_image_processor_backend` применяет выбор **только к под-процессору изображений**. При `auto` функция выходит сразу, ничего не передавая, — итоговый backend выбирает сам Transformers. При явном значении под-процессор пересоздается: `AutoImageProcessor.from_pretrained(..., backend=backend)`, а `backend`/`use_fast` из общих kwargs выбрасываются.

Почему именно так: `ProcessorMixin` раздает общие kwargs всем под-процессорам сразу, поэтому `backend`, переданный через `AutoProcessor`, доехал бы и до токенизатора, и до видео-процессора, где он значит другое или вообще read-only. Пересоздание пропускается, если у процессора нет `image_processor` или его `backend` уже совпадает с запрошенным.

Второй эффект — устройство препроцессинга. `BaseMultimodalProcessor` выводит внутренний признак `disable_fast_image_processor = (image_processor_backend == "pil")`, и только когда он `False`, в вызов процессора добавляется `device=`. Устройство выбирает `_fast_image_processor_device`: `cpu` на CPU-платформе и при заданном `--rl-on-policy-target`, `xpu` на XPU, иначе `cuda:<base_gpu_id>` (на NPU — с патчами под конкретные модели). То есть `pil` гарантированно оставляет всю подготовку картинок на CPU.

В EPD-схеме `pil` дополнительно снимает флаг `use_image_processor_gpu` у encode-сервера.

## Значения и формат

- `auto` (по умолчанию) — SGLang не передает `backend` вовсе, решение остается за Transformers. Для современных процессоров это обычно быстрый путь, но гарантии нет: зависит от версии Transformers и от самого чекпоинта.
- `torchvision` — потребовать быстрый путь явно. Именно этого варианта не хватало старому булеву флагу.
- `pil` — принудительно совместимый CPU-путь. Осмысленно только как обход поломки.
- Проверять надо именно эффективный backend, а не аргумент: при `auto` он определяется внутри Transformers.

## Когда использовать

- Не трогать по умолчанию: `auto` — рабочий выбор.
- `pil` — когда быстрый процессор дает неверный результат или падает на конкретном чекпоинте (искажения после resize, несовпадение числа патчей, ошибки внутри `torchvision`-трансформов). Это диагностический и обходной режим.
- `pil` — когда препроцессинг обязан остаться на CPU: GPU занят под завязку, а картинки крупные и `device=cuda:...` дает всплески VRAM в tokenizer-процессе.
- `torchvision` — когда нужен воспроизводимый быстрый путь независимо от версии Transformers, например чтобы замер производительности не менялся при обновлении зависимостей.

## Влияние на производительность и память

- CPU и latency: `pil` заметно дороже на крупных изображениях и высоком разрешении, и стоимость ложится на tokenizer-процесс, который на пути каждого мультимодального запроса. На потоке картинок это видно как рост TTFT.
- VRAM: `torchvision`/`auto` с `device=cuda:<base_gpu_id>` считают препроцессинг на базовой карте — короткие всплески памяти под промежуточные тензоры. `pil` этих всплесков не дает.
- На веса модели, размер KV-пула и время старта аргумент не влияет: он меняет только подготовку входов.
- С `--mm-feature-transport` не пересекается: тот отвечает за передачу уже готовых признаков, а не за их вычисление.

## Взаимодействие с другими аргументами

- `--disable-fast-image-processor`: устаревший предшественник, эквивалентен `--image-processor-backend=pil`. Указывать оба можно, только если новый флаг равен `auto` или `pil`, иначе `ValueError`.
- `--base-gpu-id`: задает карту, на которой считает быстрый процессор (`cuda:<base_gpu_id>`).
- `--rl-on-policy-target`: принудительно возвращает препроцессинг на CPU даже при быстром backend'е.
- `--encoder-only`: в EPD-схеме `pil` отключает GPU-препроцессинг на encode-сервере.
- `--mm-process-config`: настраивает параметры обработки (image/video/audio), но не выбор backend'а.
- `--enable-mm-global-cache`: кеш эмбеддингов ViT работает после препроцессинга и от backend'а не зависит.

## Типовые проблемы и диагностика

- **Симптом:** `Unsupported image processor backend: X. Expected one of ['auto', 'pil', 'torchvision'].` **Причина:** опечатка в значении. **Лечение:** одно из трех имен.
- **Симптом:** `use_fast=False conflicts with image_processor_backend='torchvision'.` **Причина:** одновременно заданы устаревший и новый флаг с противоположным смыслом. **Лечение:** оставить только новый.
- **Симптом:** `--disable-fast-image-processor conflicts with --image-processor-backend=torchvision.` **Причина:** то же самое, но поймано раньше, в `_handle_deprecated_args`. **Лечение:** убрать устаревший флаг.
- **Симптом:** предупреждение `--disable-fast-image-processor is deprecated; use --image-processor-backend=pil instead.` **Причина:** запуск со старым флагом. **Лечение:** заменить на новый; поведение при этом не меняется.
- **Симптом:** артефакты на картинках или расхождение числа визуальных токенов между сборками. **Причина:** `auto` выбрал разные backend'ы на разных версиях Transformers. **Лечение:** зафиксировать `torchvision` или `pil` явно и сравнить.
- Что смотреть: дамп `server_args=` при старте подтверждает принятое значение (и уже с учетом перезаписи из устаревшего флага).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --image-processor-backend torchvision
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --image-processor-backend pil
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
