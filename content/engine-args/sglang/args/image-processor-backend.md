---
schema: 1
engine: sglang
primaryName: "--image-processor-backend"
title: "--image-processor-backend"
summary: Выбирает Transformers image processor backend: автоматический, быстрый torchvision или PIL. `pil` также отключает передачу device в препроцессор и оставляет resize/normalize на CPU.
group: mm
related:
  - --disable-fast-image-processor
  - --mm-processor-worker-num
  - --mm-process-config
  - --base-gpu-id
---

# --image-processor-backend

## Кратко

Аргумент управляет только image sub-processor внутри мультимодального `AutoProcessor`. `auto` оставляет выбор Transformers; `torchvision` и `pil` явно перезагружают `AutoImageProcessor` с нужным backend. Для `pil` SGLang также не передает `device=` в вызов processor'а, поэтому image resize/normalize выполняется на CPU.

## Оригинальная справка

```text
Image processor backend. 'auto' lets Transformers select the best available backend.
```

## Паспорт аргумента

- Флаги: `--image-processor-backend`
- Группа: `mm`
- Тип значения: enum
- Допустимые значения: `auto`, `torchvision`, `pil`
- Значение по умолчанию: `auto`
- Где объявлен: `ServerArgs.image_processor_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: загрузка HF processor при старте → создание SGLang multimodal processor → каждый image preprocess

## Что меняет в движке

`get_processor` сначала загружает общий processor, затем `_apply_image_processor_backend` при явном значении заменяет только `processor.image_processor` через `AutoImageProcessor.from_pretrained(..., backend=...)`. Tokenizer и video/audio sub-processors не получают двусмысленный `backend` kwarg.

`BaseMultimodalProcessor` считает только `pil` медленным backend'ом. Для него не выбирается `_fast_image_processor_device`; для `auto`/`torchvision` compatible fast processor может выполнять операции на `cuda:<base_gpu_id>`, XPU или NPU. Выбранный backend входит в fingerprint preprocessing cache, поэтому результаты разных backend'ов не смешиваются.

## Значения и формат

- `auto` — не заменять image processor после `AutoProcessor`; выбор делает Transformers.
- `torchvision` — принудить fast torchvision backend.
- `pil` — принудить PIL backend и CPU preprocessing.
- Старый `--disable-fast-image-processor` транслируется в `pil`; одновременно задать его с `torchvision` нельзя.

## Когда использовать

`pil` применяют для совместимости и сравнения с эталонным CPU preprocessing. `torchvision` полезен, когда нужен явный fast path и окружение содержит совместимые torchvision/Transformers. `auto` — безопасный default, если нет воспроизводимого расхождения.

## Влияние на производительность и память

`torchvision`/fast backend обычно снижает multimodal TTFT, но создает временные buffers и compute load на device. `pil` переносит работу и память на CPU, повышая TTFT и нагрузку на processor workers. На текстовый decode и постоянный KV pool аргумент не влияет.

## Взаимодействие с другими аргументами

- `--disable-fast-image-processor` deprecated и эквивалентен `--image-processor-backend pil`.
- `--mm-processor-worker-num` определяет параллелизм CPU preprocessing, особенно важный для `pil`.
- `--mm-process-config` задает параметры resize/normalize, а backend определяет их реализацию.
- `--base-gpu-id` выбирает CUDA device fast processor'а; при `pil` не используется.

## Типовые проблемы и диагностика

- Conflict с `--disable-fast-image-processor` и `torchvision` — удалите legacy-флаг.
- Явный backend не поддержан установленной версией Transformers/processor'ом — ошибка возникает при `AutoImageProcessor.from_pretrained`.
- Итоговое значение видно в `server_args=` и в preprocessing fingerprint; рост CPU и TTFT после `pil` ожидаем.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen-VL --image-processor-backend torchvision
```

```bash
python -m sglang.launch_server --model-path /models/Qwen-VL --image-processor-backend pil --mm-processor-worker-num 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`

