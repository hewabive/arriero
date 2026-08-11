---
schema: 1
engine: vllm
primaryName: "--mm-processor-device"
title: "--mm-processor-device"
summary: Сокращение для `--mm-processor-kwargs '{"device": ...}'`: где выполняется image/video-трансформ HF-процессора. Разрешить его в акселератор можно только на encode-only инстансе EPD-развёртки — на обычном сервере движок это запрещает.
group: MultiModalConfig
related:
  - --mm-processor-kwargs
  - --mm-tensor-ipc
  - --ec-transfer-config
  - --mm-encoder-only
  - --mm-device-do-normalize
  - --mm-ipc-gpu-memory-gb
  - --gpu-memory-utilization
---

# --mm-processor-device

## Кратко

Флаг собственного состояния не имеет: его значение сворачивается в `mm_processor_kwargs["device"]`, и дальше всё читает только оттуда. Явный `device` в `--mm-processor-kwargs` побеждает.

Работает он лишь для «fast» (torchvision-based) процессоров HuggingFace, которые принимают аргумент `device`; остальные его игнорируют и остаются на CPU. И главное ограничение — политика: запускать препроцессинг на акселераторе разрешено только там, где акселератор не занят языковой моделью, то есть на encode-only инстансе разнесённой encode/prefill/decode-схемы.

Аргумент новый: в исходники checkout'а он попал за несколько дней до снятия snapshot'а. В установленной у вас сборке его может не быть — проверяйте `vllm serve --help` в нужном окружении.

## Оригинальная справка

```text
Device the HF multi-modal processor runs the image/video transform on. Convenience for `--mm-processor-kwargs '{"device": ...}'`: the value is resolved here and stored there, it is not kept as separate state. Only takes effect for HF "fast" (torchvision-backed) processors, which accept a `device` argument; the others ignore it and stay on CPU.

"auto" uses the accelerator on encoder instances of an encode/prefill/decode deployment -- an EC producer that is not also a consumer allocates no KV cache, so its accelerator is not contended by the language model -- and then only when `--mm-tensor-ipc=torch_shm` can carry device tensors, since every other transport would copy the result back to the host and that copy costs more than it saves. "auto" resolves to "cpu" everywhere else.
```

## Паспорт аргумента

- Флаги: `--mm-processor-device`
- Группа argparse: `MultiModalConfig`
- Тип значения: строка (имя torch-устройства)
- Допустимые значения: `choices` собираются **в момент построения парсера**: `["auto", "cpu"]` плюс `current_platform.device_type`, если он не пустой и не `"cpu"`. То есть на CUDA/ROCm-хосте это `auto`, `cpu`, `cuda`; на XPU — `auto`, `cpu`, `xpu`; на CPU-хосте — только `auto`, `cpu`. Реальный список для вашей машины показывает `vllm serve --help`, статически он не разрешим — поэтому в extract `choices: null`
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в `VllmConfig._resolve_mm_processor_device()` уже после того, как известна EC-роль инстанса: акселератор — только на encode-only инстансе с `--mm-tensor-ipc torch_shm`, во всех остальных случаях CPU
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: сборка `MultiModalConfig` (свёртка в kwargs) → `VllmConfig.__post_init__` (разрешение `auto` и валидация) → препроцессинг каждого запроса

## Что меняет в движке

**Свёртка.** `MultiModalConfig.fold_mm_processor_device(mm_processor_kwargs, mm_processor_device)`: при `None`/`auto` kwargs остаются как есть (`auto` намеренно не разрешается здесь — на этом уровне EC-роль ещё неизвестна); при явном `device` в kwargs флаг игнорируется; иначе в kwargs добавляется `"device"`. Любое явное значение, кроме `cpu`, означает «акселератор», поэтому программно заданный `"cuda"` продолжает работать на платформе, чей `device_type` называется иначе.

**Разрешение `auto`.** `VllmConfig._resolve_mm_processor_device()` выходит без изменений, если устройство уже задано явно, если платформа CPU-only, или если инстанс не является encode-only EC-производителем. Даже на encode-only инстансе при `mm_tensor_ipc != "torch_shm"` он пишет `EPD encoder instance: keeping the multi-modal processor on CPU because mm_tensor_ipc=%s cannot carry device tensors. Add --mm-tensor-ipc=torch_shm to run it on the accelerator.` и оставляет CPU. Успешный случай: `EPD encoder instance: running the multi-modal processor on cuda. Override with --mm-processor-device=cpu.`

**Валидация.** `MultiModalConfig.validate_mm_processor_device(ec_config)` разбирает значение через `torch.device(...)` (поэтому принимаются и `cuda:1`, и объект `torch.device`, и голый индекс) и бьёт по двум причинам:

- значение не является torch-устройством → `Invalid "device" in mm_processor_kwargs: ...`;
- запрошен акселератор на инстансе, который **сам исполняет языковую модель** → длинная ошибка, объясняющая, что трансформ-ядра будут конкурировать с forward-проходом, а его аллокации лежат вне памяти, которую движок профилировал под KV-cache; заканчивается подсказкой `Use --mm-processor-device=cpu, or drop "device" from --mm-processor-kwargs.`

**Использование.** Значение доезжает до HF-процессора как обычный kwarg. Кроме того, `InputProcessingContext._postprocess_output` копирует результат на хост, если транспорт не `torch_shm` — device-препроцессинг без `torch_shm` не даёт выигрыша, а добавляет копию.

## Значения и формат

- `auto` — дефолт. Разрешается по правилу выше; на подавляющем большинстве развёрток это `cpu`.
- `cpu` — принудительно хост. Это же способ отменить `auto` на encode-only инстансе.
- Имя акселератора платформы (`cuda` на CUDA и ROCm, `xpu` на XPU) — принудительно устройство. На инстансе, который держит языковую модель, это ошибка старта, а не предупреждение.
- Формы с индексом (`cuda:0`) через CLI не пройдут по `choices`, но допустимы, если писать напрямую в `--mm-processor-kwargs '{"device": "cuda:0"}'`; валидация тогда идёт через `torch.device`.
- Эффекта не будет вовсе, если у модели «медленный» (не torchvision) HF-процессор: он просто не принимает `device`.

## Когда использовать

- Encode-only инстанс EPD-развёртки, где акселератор простаивает между прогонами энкодера: `--mm-processor-device auto` (или явно имя устройства) плюс `--mm-tensor-ipc torch_shm` переносит ресайз/кроп на GPU и снимает нагрузку с CPU API-процесса.
- Отладка: `--mm-processor-device cpu` фиксирует поведение и исключает device-путь из подозреваемых.
- Не задавайте акселератор на обычном сервере: движок откажется стартовать, и это правильно — препроцессинг в API-процессе аллоцирует память вне профилированного бюджета.
- Не рассчитывайте на ускорение, не проверив, что у модели fast-процессор: молчаливый откат на CPU выглядит как «флаг не работает».

## Влияние на производительность и память

- **CPU хоста.** Основной выигрыш: ресайз/нормализация уезжают с CPU API-процесса, который на мультимодальной нагрузке обычно и есть узкое место.
- **VRAM.** На encode-only инстансе KV-cache не выделяется, поэтому конкуренции нет. На любом другом — конкуренция была бы, и именно поэтому конфигурация запрещена. Бюджетирование GPU-работы фронтенда — отдельный аргумент `--mm-ipc-gpu-memory-gb`.
- **Latency.** Падает на крупных изображениях/видео; при транспорте, отличном от `torch_shm`, обнуляется копированием результата обратно на хост.
- **Время старта.** Не влияет.
- **RAM хоста.** Немного снижается: промежуточные буферы трансформа живут на устройстве.

## Взаимодействие с другими аргументами

- `--mm-processor-kwargs`: единственное место хранения. Явный `"device"` там перебивает этот флаг, и `auto` тогда не разрешается вовсе.
- `--mm-tensor-ipc`: `torch_shm` — обязательное условие для `auto`-разрешения в акселератор; при `direct_rpc` device-тензор всё равно копируется на хост.
- `--ec-transfer-config`: задаёт EC-роль, по которой и определяется «encode-only». Без EPD-развёртки `auto` всегда даёт CPU.
- `--mm-encoder-only`: типичный спутник encode-only инстанса (не грузит языковую часть), но саму роль задаёт EC-конфиг, а не он.
- `--mm-device-do-normalize`: другой способ перенести часть препроцессинга на устройство — нормализацию непосредственно перед ViT; работает независимо от этого флага.
- `--gpu-memory-utilization`, `--mm-ipc-gpu-memory-gb`: бюджет карты, из которого device-препроцессинг не учтён; именно это и есть аргумент запрета на совмещённом инстансе.

## Типовые проблемы и диагностика

- **Симптом:** `Cannot run the multi-modal processor on 'cuda': this instance also runs the language model.` **Причина:** акселератор запрошен на инстансе с языковой моделью. **Лечение:** `--mm-processor-device cpu` или убрать `"device"` из `--mm-processor-kwargs`.
- **Симптом:** `Invalid "device" in mm_processor_kwargs: ...` **Причина:** значение не разбирается `torch.device`. **Лечение:** использовать `cpu`, `cuda`, `cuda:0`.
- **Симптом:** флаг задан, а в логе `EPD encoder instance: keeping the multi-modal processor on CPU because mm_tensor_ipc=direct_rpc cannot carry device tensors.` **Причина:** транспорт не `torch_shm`. **Лечение:** добавить `--mm-tensor-ipc torch_shm`.
- **Симптом:** старт прошёл, но ускорения нет и в логе нет строки `Running the multi-modal processor on cuda.` **Причина:** `auto` разрешился в CPU (не encode-only инстанс), либо у модели не fast-процессор. **Проверка:** `vllm serve --help` покажет реальный список `choices`, а лог — итоговое решение.
- **Симптом:** argparse отвергает значение. **Причина:** `choices` строятся по `current_platform.device_type` вашей машины; на CPU-хосте акселератора в списке нет.
- **Подтверждение принятого значения:** `Running the multi-modal processor on %s. Override with --mm-processor-device=cpu.` (info, один раз) либо строка про сохранение CPU.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-device cpu --limit-mm-per-prompt '{"image": 2}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-device cuda --mm-tensor-ipc torch_shm --mm-encoder-only --ec-transfer-config '{"ec_connector": "ECExampleConnector", "ec_role": "ec_producer", "ec_connector_extra_config": {"shared_storage_path": "/tmp/ec-cache"}}'
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/ec_transfer.py`
- `vllm/vllm/multimodal/processing/context.py`
- `vllm/docs/features/disagg_encoder.md`
