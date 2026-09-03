---
schema: 1
engine: vllm
primaryName: "--mm-device-do-normalize"
title: "--mm-device-do-normalize"
summary: Переносит rescale и normalize мультимодального входа с CPU на устройство непосредственно перед vision encoder. Автоматически включается только для моделей, явно объявивших поддержку.
group: MultiModalConfig
related:
  - --mm-processor-kwargs
  - --mm-processor-device
  - --model-impl
---

# --mm-device-do-normalize

## Кратко

Флаг отключает `do_rescale` и `do_normalize` в Hugging Face processor и выполняет эквивалентное преобразование тензора на устройстве перед ViT. Это экономит CPU-работу; сейчас поддержку объявляют реализации Qwen2-VL и Qwen2.5-VL.

## Оригинальная справка

```text
Move the do_normalize computation in the mm preprocessing to before the ViT, 
and let the device do it, so that CPU computation can be saved.
```

## Паспорт аргумента

- Флаги: `--mm-device-do-normalize`, `--no-mm-device-do-normalize`
- Группа argparse: `MultiModalConfig`
- Тип значения: optional bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: положительная/отрицательная форма либо отсутствие флага
- Значение по умолчанию: CLI `None`; поле config имеет `True`, но effective value разрешается моделью
- Эффективное значение: при `None` включается только если model registry сообщает `supports_mm_device_do_normalize`; Rust frontend всегда принудительно выключает. Явное `true` также сбрасывается в `false` для неподдерживаемой модели или Rust frontend
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_device_do_normalize`
- Этап применения: сборка `ModelConfig` → настройка HF processor → forward vision encoder

## Что меняет в движке

При включении vLLM добавляет `do_normalize=false` и `do_rescale=false` в kwargs processor. `FusedInputNorm` читает `image_mean`, `image_std` и `rescale_factor` из processor config и выполняет rescale/normalize на тензоре непосредственно перед ViT. Изменяется место вычисления, а не целевое преобразование изображения.

## Значения и формат

- Не задан: автоматический выбор по capability модели.
- `--mm-device-do-normalize`: запросить перенос; неподдерживаемая модель даст warning и effective `false`.
- `--no-mm-device-do-normalize`: оставить preprocessing на CPU.

## Когда использовать

- Оставьте auto для поддерживаемой Qwen-VL: это штатный путь.
- Явно выключайте при сравнении численности с Hugging Face preprocessing или диагностике расхождения изображений.
- Не пытайтесь форсировать на произвольной ViT-модели: capability-проверка всё равно отключит режим.

## Влияние на производительность и память

Режим сокращает CPU preprocessing и переносит небольшую elementwise-операцию на accelerator. Формат исходного тензора до ViT может увеличить объём H2D по сравнению с заранее нормализованным CPU-результатом; дополнительная device-память ограничена промежуточным image tensor и не меняет KV-cache.

## Взаимодействие с другими аргументами

- `--mm-processor-kwargs`: vLLM сам проставляет `do_normalize=false` и `do_rescale=false`; конфликтующие ручные overrides не следует использовать.
- `--mm-processor-device`: может перенести весь fast processor на accelerator; этот флаг переносит только normalize/rescale перед ViT.
- `--model-impl`: поддержка определяется выбранной реализацией модели, а не только HF architecture.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но в debug-логе `mm_device_do_normalize is disabled`. **Причина:** реализация модели не объявляет capability. **Лечение:** снять флаг либо выбрать поддерживаемую реализацию.
- **Симптом:** warning про `VLLM_USE_RUST_FRONTEND`. **Причина:** Rust frontend пока не поддерживает путь. **Лечение:** оставить режим выключенным или использовать Python frontend.
- **Симптом:** качество отличается от CPU baseline. **Проверка:** повторить запуск с `--no-mm-device-do-normalize`; сверить mean/std/rescale processor config.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-device-do-normalize
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --no-mm-device-do-normalize
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/models/vision.py`
- `vllm/vllm/model_executor/models/qwen2_vl.py`
- `vllm/vllm/model_executor/models/qwen2_5_vl.py`
