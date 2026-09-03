---
schema: 1
engine: sglang
primaryName: "--disable-fast-image-processor"
title: "--disable-fast-image-processor"
summary: Устаревший совместимый флаг для `--image-processor-backend pil`. При разборе еще принимается, но печатает предупреждение и переписывает актуальное поле; в новых профилях использовать его не следует.
group: mm
related:
  - --image-processor-backend
  - --mm-processor-worker-num
  - --mm-process-config
  - --base-gpu-id
---

# --disable-fast-image-processor

## Кратко

Флаг deprecated. Он сохранен для старых команд запуска, но `_handle_deprecated_args` печатает warning и заменяет его на `image_processor_backend="pil"`. Новые конфигурации должны задавать `--image-processor-backend pil` напрямую.

## Оригинальная справка

```text
Deprecated. Use --image-processor-backend=pil instead.
```

## Паспорт аргумента

- Флаги: `--disable-fast-image-processor`
- Группа: `mm`
- Тип значения: bool, флаг без значения
- Значение по умолчанию: `false`
- Где объявлен: `ServerArgs.disable_fast_image_processor`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: deprecated; замена — `--image-processor-backend pil`
- Этап применения: разбор CLI → `_handle_deprecated_args` → загрузка image processor

## Что меняет в движке

Если legacy-флаг установлен, SGLang сначала проверяет актуальное поле. При `auto` или `pil` печатается предупреждение, после чего `image_processor_backend` становится `pil`. Если одновременно явно выбран `torchvision`, старт прекращается из-за конфликта.

Дальше действует только семантика актуального backend: image sub-processor загружается как PIL-вариант, а `BaseMultimodalProcessor` не передает ему `device=`, оставляя preprocessing на CPU.

## Значения и формат

Флаг не принимает значение и не имеет `--no-*` пары. Он не является отдельным режимом: после post-init эффективная конфигурация эквивалентна `--image-processor-backend pil`.

## Когда использовать

Не добавляйте аргумент в новые профили. Оставить его временно можно только для совместимости со старой автоматизацией; миграция механическая — заменить на `--image-processor-backend pil`.

## Влияние на производительность и память

Эффект совпадает с PIL backend: resize/normalize переезжают на CPU, поэтому multimodal TTFT и CPU load могут вырасти, а временная GPU-нагрузка preprocessing исчезает. Сам deprecated shim дополнительных ресурсов не расходует.

## Взаимодействие с другими аргументами

- `--image-processor-backend pil` — прямая замена.
- `--image-processor-backend torchvision` вместе с legacy-флагом дает `ValueError`.
- `--mm-processor-worker-num` определяет CPU-параллелизм, который особенно важен для PIL.
- `--base-gpu-id` не используется image preprocessing в PIL-режиме.

## Типовые проблемы и диагностика

- Warning `--disable-fast-image-processor is deprecated; use --image-processor-backend=pil instead.` — ожидаемый сигнал для миграции.
- `...conflicts with --image-processor-backend=torchvision` — удалите legacy-флаг либо выберите `pil`.
- Проверяйте эффективное `image_processor_backend='pil'` в дампе `server_args=` после post-init.

## Примеры

Рекомендуемая замена:

```bash
python -m sglang.launch_server --model-path /models/Qwen-VL --image-processor-backend pil
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/hf_transformers/processor.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
