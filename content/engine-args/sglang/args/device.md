---
schema: 1
engine: sglang
primaryName: "--device"
title: "--device"
summary: Тип ускорителя, на котором работает движок. Не задан — определяется автоматически по установленным пакетам; индекс устройства здесь не задается и молча отбрасывается.
group: device
related:
  - --base-gpu-id
  - --gpu-id-step
  - --attention-backend
  - --sampling-backend
  - --mem-fraction-static
  - --enable-quant-communications
  - --disable-overlap-schedule
  - --tp-size
---

# --device

## Кратко

`--device` выбирает **класс** ускорителя (`cuda`, `cpu`, `npu`, `xpu`, `hpu`, `musa`, а также необъявленный в справке `mps`), а не конкретную карту. Значение попадает в `ServerArgs.device` на самом раннем шаге `__post_init__` и дальше работает как переключатель целых веток настройки: от него зависят backend внимания, backend сэмплирования, способ измерения объема памяти для автоподбора `--mem-fraction-static` и доступность CUDA graph. **Индекс в значении отбрасывается**: `--device cuda:1` превращается в `cuda`, выбор конкретных карт делают `CUDA_VISIBLE_DEVICES`, `--base-gpu-id` и `--gpu-id-step`.

## Оригинальная справка

```text
The device to use ('cuda', 'xpu', 'hpu', 'npu', 'cpu', 'musa'). Defaults to auto-detection if not specified.
```

## Паспорт аргумента

- Флаги: `--device`
- Группа: `device`
- Тип значения: str (`Optional[str]`)
- Допустимые значения: `choices` в объявлении нет — argparse примет любую строку. Перечень в тексте справки (`cuda`, `xpu`, `hpu`, `npu`, `cpu`, `musa`) неполон: код отдельно обрабатывает `mps` (`_handle_mps_backends`) и умеет отдавать имя из плагина платформы (`current_platform.get_device`). Неизвестное значение не отвергается на разборе — оно просто не совпадет ни с одной веткой и приведет к отказу позже, на инициализации torch
- Значение по умолчанию: `null` — «определить автоматически»
- Эффективное значение: `_handle_missing_default_values` подставляет `get_device()` (`sglang/python/sglang/srt/utils/common.py`), а затем **безусловно** выполняет `self.device = self.device.split(":")[0]` — суффикс `:N` отбрасывается и у явно заданного значения тоже
- Где объявлен: `ServerArgs.device`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_missing_default_values` → `_handle_hpu_backends` / `_handle_cpu_backends` / `_handle_npu_backends` / `_handle_mps_backends` / `_handle_xpu_backends` → `_handle_gpu_memory_settings` → `_handle_cuda_graph_config`) → выбор distributed-backend в `init_torch_distributed` → инициализация model runner

## Что меняет в движке

### Автоопределение

`get_device()` (кешируется через `lru_cache`) проверяет платформы в фиксированном порядке и возвращает **первую** доступную:

1. `is_cpu()` — сборка без ускорителя; печатает `Intel AMX is detected, using CPU with Intel AMX support.` либо предупреждение `CPU device enabled, using torch native backend, low performance expected.`;
2. `torch.cuda.is_available()` → `cuda` (сюда же попадает ROCm-сборка PyTorch);
3. `torch.xpu.is_available()` → `xpu`;
4. `is_npu()` → `npu`;
5. Habana → `hpu`;
6. `is_musa()` → `musa`;
7. `is_mps()` → `mps`;
8. плагин платформы; иначе `RuntimeError: No accelerator (CUDA, XPU, HPU, NPU, MUSA, MPS) or platform plugin is available.`

Автоопределение не смотрит на `CUDA_VISIBLE_DEVICES` напрямую, но зависит от него косвенно: при `CUDA_VISIBLE_DEVICES=""` `torch.cuda.is_available()` вернет `False`, и движок молча уйдет на следующую платформу в списке.

### Ветки настройки по устройству

- `cpu` (`_handle_cpu_backends`): `attention_backend` при незаданном значении становится `torch_native` на ARM64 и `intel_amx` в остальных случаях; `sampling_backend` принудительно `pytorch`. Кроме того, при `device == "cpu"` пропускается генерация списка batch-размеров decode-графа, а `init_torch_distributed` вызывает `_init_cpu_threads_env` — привязку OpenMP-потоков по `SGLANG_CPU_OMP_THREADS_BIND` (по умолчанию — один TP-ранг на NUMA-узел).
- `hpu`: `attention_backend = torch_native`, `sampling_backend = pytorch`.
- `npu`: применяется `set_default_server_args` из `hardware_backend/npu/utils.py`; prefill-компилятор графа принудительно `eager` с предупреждением. Только на `npu` разрешен `--enable-quant-communications`.
- `xpu`: decode-граф выключается по умолчанию, если `--cuda-graph-backend-decode` не задан явно; из явных значений принимается только `full`.
- `mps`: без MLX включается `disable_overlap_schedule`.
- `cuda`: специальной ветки нет — это опорный путь, для которого написано все остальное.

### Влияние на расчет памяти

`get_device_memory_capacity(self.device)` (вход `_handle_gpu_memory_settings`) выбирает источник емкости по устройству: CUDA — `nvidia-smi --query-gpu=memory.total` (минимум по видимым картам), HIP — аналог для AMD, `npu`/`hpu`/`xpu`/`musa` — свои запросы, `cpu` — `psutil.virtual_memory().total`, поделенный на число NUMA-узлов. То есть на `--device cpu` доля `--mem-fraction-static` считается от **RAM одного узла**, а не от VRAM.

Отдельно `post_capture_kv_sizing_planned()` (пересчет KV-пула после захвата графов) требует ровно `device == "cuda"` и отключается на любом другом устройстве.

## Значения и формат

- Строка без пробелов. Регистр значим: `CUDA` ни с одной веткой не совпадет.
- Суффикс индекса допустим синтаксически (`cuda:0`), но бессмыслен: он снимается в `_handle_missing_default_values`. Не используйте его как способ выбрать карту.
- Не задавать аргумент — и есть «авто»; отдельного значения `auto` нет.
- Неизвестное значение (`gpu`, `rocm`) argparse примет молча. Отказ придет позже — от torch при создании `torch.device` или от distributed-слоя.
- Для ROCm-сборки правильное значение — `cuda`: SGLang различает CUDA и HIP по сборке PyTorch (`is_hip()`), а не по значению этого аргумента.

## Когда использовать

- Задавать явно на хосте, где рядом с CUDA установлены другие backend'ы (Habana, Intel XPU) и порядок автоопределения может выбрать не то. Признак — в дампе `server_args=` при старте `device=` не тот, что ожидался.
- Задавать `--device cpu` осмысленно только для проверки конфигурации без GPU: путь `intel_amx`/`torch_native` рабочий, но по throughput несопоставим.
- Не задавать ради выбора карты — для этого есть `CUDA_VISIBLE_DEVICES` и `--base-gpu-id`.
- **В arriero:** для instance kind `ktransformers` `--device cpu` неприменим. Preflight (`apps/api/src/process/preflight-ktransformers.ts`) требует NVIDIA GPU, видимую через NVML, и положительный host-резерв; сам профиль KTransformers — это гибрид «GPU + CPU-эксперты», а не CPU-инференс.

## Влияние на производительность и память

- VRAM: напрямую не меняет ничего, но определяет **источник** емкости для автоподбора `--mem-fraction-static` и включает/выключает пересчет KV-пула после захвата графов (только `cuda`).
- RAM хоста: на `cpu` вся модель и KV-пул живут в RAM, и `--mem-fraction-static` считается от RAM одного NUMA-узла.
- Время старта: косвенно — через выбранный backend внимания и через то, захватываются ли CUDA graph (на `xpu` и `mps` по умолчанию не захватываются).
- Throughput/latency: определяется выбранным путем целиком; сравнивать значения между собой имеет смысл только на одинаковом железе.

## Взаимодействие с другими аргументами

- `--attention-backend` / `--sampling-backend`: на `cpu` и `hpu` значения подставляются принудительно, явное значение backend'а сэмплирования на этих устройствах переписывается.
- `--mem-fraction-static`: устройство выбирает способ измерения емкости (см. выше).
- `--enable-quant-communications`: работает только при `--device npu`, иначе `ValueError: Communications quantization is only supported for NPU device`.
- `--disable-overlap-schedule`: включается автоматически на `mps` без MLX.
- `--base-gpu-id` / `--gpu-id-step`: работают внутри выбранного класса устройств и оперируют логическими индексами.
- `--tp-size`: на `cpu` число рангов практически ограничено числом NUMA-узлов (см. `init_threads_binding`), иначе требуется явный `SGLANG_CPU_OMP_THREADS_BIND`.

## Типовые проблемы и диагностика

- `RuntimeError: No accelerator (CUDA, XPU, HPU, NPU, MUSA, MPS) or platform plugin is available.` — автоопределение не нашло ничего. Обычно это либо `CUDA_VISIBLE_DEVICES=""`/`-1`, либо CPU-сборка PyTorch. Проверяется одной строкой: `python -c "import torch; print(torch.cuda.is_available(), torch.cuda.device_count())"` в том же окружении.
- Движок стартует на CPU, хотя карта есть — смотрите `device=` в дампе `server_args=` и предупреждение `CPU device enabled, using torch native backend, low performance expected.` в первых строках лога.
- `--device cuda:1` не привел к смене карты — так и задумано, индекс отбрасывается. Используйте `CUDA_VISIBLE_DEVICES=1` или `--base-gpu-id 1`.
- `ValueError: Communications quantization is only supported for NPU device` — `--enable-quant-communications` задан на CUDA.
- Что смотреть в логе: `device=` в итоговом дампе `server_args=` (`sglang/python/sglang/srt/entrypoints/engine.py`), выбранный attention backend и строку `Init torch distributed begin.`/`Init torch distributed ends.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --device cuda --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --device cpu --tensor-parallel-size 1 --max-running-requests 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/utils/numa_utils.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
