---
schema: 1
engine: vllm
primaryName: "--mm-processor-device"
title: "--mm-processor-device"
summary: Выбирает устройство для torchvision-backed fast HF processor. Accelerator разрешён только на encode-only producer в EPD-развёртывании с tensor IPC через torch_shm; во всех обычных конфигурациях auto оставляет processor на CPU.
group: MultiModalConfig
related:
  - --mm-processor-kwargs
  - --mm-tensor-ipc
  - --ec-transfer-config
  - --mm-ipc-gpu-memory-gb
---

# --mm-processor-device

## Кратко

Аргумент — удобная форма ключа `device` в `--mm-processor-kwargs`. Он влияет только на быстрые HF image/video processors, которые принимают параметр `device`; остальные игнорируют его и работают на CPU.

## Оригинальная справка

```text
Device the HF multi-modal processor runs the image/video transform on. Convenience for `--mm-processor-kwargs '{"device": ...}'`: the value is resolved here and stored there, it is not kept as separate state. Only takes effect for HF "fast" (torchvision-backed) processors, which accept a `device` argument; the others ignore it and stay on CPU.

"auto" uses the accelerator on encoder instances of an encode/prefill/decode deployment -- an EC producer that is not also a consumer allocates no KV cache, so its accelerator is not contended by the language model -- and then only when `--mm-tensor-ipc=torch_shm` can carry device tensors, since every other transport would copy the result back to the host and that copy costs more than it saves. "auto" resolves to "cpu" everywhere else.
```

## Паспорт аргумента

- Флаги: `--mm-processor-device`
- Группа argparse: `MultiModalConfig`
- Тип значения: runtime-список устройств
- Допустимые значения: `auto`, `cpu` и текущий `current_platform.device_type`, если платформа имеет accelerator (`cuda`, `xpu` и т. п.); поэтому extract не фиксирует `choices`
- Значение по умолчанию: `auto`
- Эффективное значение: хранится только как `mm_processor_kwargs["device"]`. Явный ключ в `--mm-processor-kwargs` имеет приоритет; `auto` добавляет accelerator лишь encode-only EC producer с `mm_tensor_ipc=torch_shm`, иначе ключ не добавляется и HF processor остаётся на CPU
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: разбор CLI → сборка `ModelConfig` → разрешение роли EPD в `VllmConfig` → мультимодальный preprocessing

## Что меняет в движке

`MultiModalConfig.fold_mm_processor_device()` сворачивает явное значение в `mm_processor_kwargs`. Любое явное не-CPU значение означает accelerator текущей платформы; прямой `mm_processor_kwargs.device` при этом не перезаписывается.

Для `auto` решение откладывается до `VllmConfig._resolve_mm_processor_device()`, где уже известна роль EC. Accelerator выбирается только если инстанс — EC producer, не являющийся consumer (`is_encode_only`), и `--mm-tensor-ipc=torch_shm` способен передать device tensor без возврата на host. Явный accelerator на инстансе, который также исполняет language model, запрещён: preprocessing конкурировал бы за compute, а его allocations находятся вне профилированного бюджета KV-cache.

## Значения и формат

- `auto` — accelerator только в безопасной encode-only/torch_shm комбинации, CPU во всех остальных случаях.
- `cpu` — принудительно оставить transform на CPU.
- Имя accelerator (`cuda`, `xpu`, …) — допустимо только на соответствующей платформе и encode-only EC producer.
- `--mm-processor-kwargs '{"device":"cpu"}'` эквивалентен convenience-флагу и имеет приоритет, если заданы оба.

## Когда использовать

- `auto` — рекомендуемый режим, особенно для EPD: он избегает лишней host-copy и не конкурирует с language model.
- `cpu` — для воспроизводимости, диагностики torchvision processor или когда device preprocessing не даёт выигрыша.
- Явный accelerator используйте лишь в проверенном encode-only EC producer; обычный `vllm serve` его отвергнет.

## Влияние на производительность и память

На encode-only producer accelerator может снять CPU bottleneck в image/video transforms. `torch_shm` избегает обратной копии на host. Device allocations принадлежат API-server process и не учитываются профилированием KV-cache, поэтому vLLM запрещает этот режим рядом с language model; на CPU пути VRAM не меняется.

## Взаимодействие с другими аргументами

- `--mm-processor-kwargs`: ключ `device` здесь имеет приоритет над convenience-флагом.
- `--mm-tensor-ipc`: для автоматического accelerator необходим `torch_shm`; прочий transport возвращает результат на host.
- `--ec-transfer-config`: определяет encode-only роль, без которой accelerator запрещён.
- `--mm-ipc-gpu-memory-gb`: задаёт отдельный GPU-memory budget для tensor IPC и важен при передаче device tensors.

## Типовые проблемы и диагностика

- **Симптом:** `Cannot run the multi-modal processor on 'cuda': this instance also runs the language model.` **Причина:** accelerator задан на обычном или consumer-инстансе. **Лечение:** вернуть `auto`/`cpu` либо вынести preprocessing в encode-only EC producer.
- **Симптом:** auto оставил processor на CPU. **Причина:** инстанс не encode-only или transport не `torch_shm`. **Проверка:** info-строка `keeping the multi-modal processor on CPU because mm_tensor_ipc=...`.
- **Симптом:** `Invalid "device" in mm_processor_kwargs`. **Причина:** значение не разбирается `torch.device`. **Лечение:** использовать runtime-choice из `vllm serve --help=mm-processor-device`.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-device cpu
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-kwargs '{"device":"cpu"}'
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/tests/config/test_multimodal_config.py`
