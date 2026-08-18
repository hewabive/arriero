---
schema: 1
engine: sglang
primaryName: "--disable-fast-image-processor"
title: "--disable-fast-image-processor"
summary: Переводит препроцессинг изображений на «базовый» (медленный, PIL-based) HF-процессор вместо быстрого torchvision-варианта и одновременно отключает выполнение препроцессинга на GPU. Ручка совместимости и отладки для мультимодальных моделей.
group: mm
related:
  - --mm-process-config
  - --mm-processor-worker-num
  - --mm-io-worker-num
  - --base-gpu-id
  - --rl-on-policy-target
  - --trust-remote-code
---

# --disable-fast-image-processor

## Кратко

У большинства мультимодальных процессоров HuggingFace два варианта обработки изображений: быстрый (`*ImageProcessorFast`, тензорные операции torchvision, умеет работать на GPU) и базовый «медленный» (PIL/NumPy, только CPU). По умолчанию SGLang запрашивает быстрый. `--disable-fast-image-processor` переключает на базовый: при загрузке процессора передается `use_fast=False`, а в вызов препроцессинга перестает подставляться `device=` — вся подготовка `pixel_values` идет на CPU средствами PIL.

Это ручка совместимости: ее включают, когда быстрый процессор конкретной модели дает иные результаты, чем базовый, падает или мешает соседям, занимая GPU препроцессингом.

## Оригинальная справка

```text
Adopt base image processor instead of fast image processor.
```

## Паспорт аргумента

- Флаги: `--disable-fast-image-processor`
- Группа: `mm`
- Тип значения: булев флаг (`store_true`, парного `--no-*` нет)
- Допустимые значения: наличие флага
- Значение по умолчанию: `False` — используется быстрый процессор
- Эффективное значение: в `__post_init__` не переписывается; читается напрямую двумя путями — как `use_fast=not …` при загрузке процессора и как гейт `device=` в `BaseMultimodalProcessor`
- Где объявлен: `ServerArgs.disable_fast_image_processor`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: загрузка HF-процессора при старте (tokenizer manager, scheduler, encode-сервер EPD) → каждый вызов препроцессинга изображений

## Что меняет в движке

Два независимых эффекта.

**Выбор класса процессора.** Все места, где создается HF-процессор мультимодальной модели, передают `use_fast=not server_args.disable_fast_image_processor` в `get_processor` (`sglang/python/sglang/srt/utils/hf_transformers/processor.py`): `tokenizer_manager.py`, `managers/scheduler.py`, `disaggregation/encode_server.py`, `disaggregation/encode_receiver.py`. Внутри `get_processor` значение уходит в `AutoProcessor.from_pretrained(..., use_fast=...)` — `use_fast=False` заставляет transformers инстанцировать базовый (медленный) вариант image processor'а. Две оговорки в том же коде:

- для `config.model_type` из `{"llava", "clip"}` параметр `use_fast` не передается вовсе — там флаг на выбор класса не влияет;
- если у процессора медленной версии не существует, transformers кидает `ValueError` с текстом `does not have a slow version`, и `get_processor` молча повторяет загрузку с `use_fast=True`, печатая `Processor <name> does not have a slow version. Automatically use fast version` — в этом случае флаг фактически игнорируется.

**Устройство препроцессинга.** `BaseMultimodalProcessor.process_mm_data` (`sglang/python/sglang/srt/multimodal/processors/base_processor.py`) подставляет `kwargs["device"]` в вызов процессора только при `not self.disable_fast_image_processor`; устройство берется из `_fast_image_processor_device` — `cuda:<base_gpu_id>` на CUDA, `cpu` при `--rl-on-policy-target`, `xpu`/`npu` на соответствующих платформах. С флагом `device=` не подставляется, и ресайз/нормализация выполняются на CPU. Та же логика продублирована в `multimodal/processors/ernie45_vl.py` и в encode-сервере EPD-disaggregation (`disaggregation/encode_server.py`: `use_image_processor_gpu and not server_args.disable_fast_image_processor`).

## Значения и формат

- Флаг без значения; обратной половины `--no-...` нет.
- Не задан — быстрый процессор, препроцессинг на устройстве из `_fast_image_processor_device`.
- Задан — базовый процессор и CPU-препроцессинг; для llava/clip и для моделей без медленной версии выбор класса не меняется (см. выше), но `device=` все равно перестает подставляться.

## Когда использовать

- Быстрый процессор конкретной модели дает результаты, отличающиеся от базового (различия в ресайзе/интерполяции torchvision против PIL), и вы хотите эталонное поведение базовой реализации — например, чтобы воспроизвести метрики, снятые на медленном пути.
- Препроцессинг на GPU мешает: он идет на `cuda:<base_gpu_id>` и отъедает память/такты у той же карты, что держит KV-пул.
- Отладка мультимодального пайплайна: исключить быстрый путь как источник расхождений.
- В остальных случаях не трогайте: быстрый процессор существенно быстрее на крупных изображениях и видео.

## Влияние на производительность и память

- TTFT мультимодальных запросов растет: базовый PIL-процессор медленнее, особенно на видео и изображениях высокого разрешения, и работает только на CPU.
- Нагрузка переезжает с GPU на CPU-воркеры препроцессинга; при большом мультимодальном трафике проверьте запас по CPU (`--mm-processor-worker-num`).
- VRAM: с флагом препроцессинг не выполняется на `--base-gpu-id`, то есть исчезают временные буферы препроцессинга на этой карте.
- На текстовые запросы и на декод не влияет.

## Взаимодействие с другими аргументами

- `--mm-processor-worker-num`, `--mm-io-worker-num`: несут CPU-нагрузку препроцессинга, которая с этим флагом только увеличивается.
- `--base-gpu-id`: без флага быстрый процессор работает именно на этой карте; с флагом карта в препроцессинге не участвует.
- `--rl-on-policy-target`: и без флага принудительно опускает устройство препроцессинга в `cpu` (но класс процессора остается быстрым).
- `--mm-process-config`, `--trust-remote-code`: влияют на то, какой процессор и с какими параметрами загрузится, но не на выбор быстрый/базовый.

## Типовые проблемы и диагностика

- **Симптом:** в логе `Processor <name> does not have a slow version. Automatically use fast version`. **Причина:** у процессора модели нет базовой версии; флаг проигнорирован при выборе класса. `device=` при этом все равно не подставляется.
- **Симптом:** заметно вырос TTFT на изображениях/видео после включения флага. **Причина:** ожидаемая цена CPU-пути; уберите флаг или добавьте CPU-воркеров.
- **Проверка принятого значения:** `disable_fast_image_processor=True` в дампе `server_args=` при старте.
- Флаг есть в декларации checkout'а; доступность в вашей установленной сборке проверяется по `python -m sglang.launch_server --help | grep disable-fast-image-processor` — каталог аргументов arriero строится из `--help` установленного движка.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --disable-fast-image-processor
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/ernie45_vl.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
