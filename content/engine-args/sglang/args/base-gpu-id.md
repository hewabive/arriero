---
schema: 1
engine: sglang
primaryName: "--base-gpu-id"
title: "--base-gpu-id"
summary: Индекс первой карты (внутри списка видимых), с которой начинается раздача GPU по рангам. Сдвигает весь экземпляр, чтобы два сервера на одном хосте не сели на одни и те же устройства.
group: device
related:
  - --gpu-id-step
  - --tp-size
  - --pp-size
  - --dp-size
  - --device
  - --nnodes
  - --node-rank
  - --numa-node
  - --use-ray
---

# --base-gpu-id

## Кратко

`--base-gpu-id` — слагаемое в формуле, по которой каждому scheduler-процессу назначается устройство. Он не выбирает физическую карту: индексы считаются **внутри списка, который уже отфильтровал `CUDA_VISIBLE_DEVICES`**. Аргумент нужен ровно в одном сценарии — несколько экземпляров SGLang на одном хосте без разделения через переменную окружения. Ошибка в нем не диагностируется движком: он спокойно займет чужие карты и упадет по OOM или встанет в очередь к занятой памяти.

## Оригинальная справка

```text
The base GPU ID to start allocating GPUs from. Useful when running multiple instances on the same machine.
```

## Паспорт аргумента

- Флаги: `--base-gpu-id`
- Группа: `device`
- Тип значения: int
- Допустимые значения: `choices` нет; проверка `assert self.base_gpu_id >= 0, "base_gpu_id must be non-negative"` в `check_server_args`. Верхняя граница не проверяется — выход за число видимых устройств обнаружится только при `torch.cuda.set_device`
- Значение по умолчанию: `0`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.base_gpu_id`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: запуск scheduler-процессов (`Engine._launch_scheduler_processes`, `DataParallelController.launch_tensor_parallel_group`), до инициализации torch.distributed

## Что меняет в движке

### Формула назначения устройства

Для каждой пары `(pp_rank, tp_rank)` локального узла считается

```python
gpu_id = server_args.base_gpu_id
       + ((pp_rank % pp_size_per_node) * tp_size_per_node)
       + (tp_rank % tp_size_per_node) * server_args.gpu_id_step
```

(`sglang/python/sglang/srt/entrypoints/engine.py`). `pp_size_per_node`/`tp_size_per_node` вычисляет `_calculate_rank_ranges` из `--nnodes`, `--pp-size`, `--tp-size` и `--node-rank`, поэтому на многоузловом запуске `base_gpu_id` — локальная величина каждого узла.

При `--dp-size > 1` контроллер добавляет второй, автоматический сдвиг: `DataParallelController.launch_dp_schedulers` наращивает внутренний `base_gpu_id` на `tp_size * pp_size * gpu_id_step` на каждую DP-реплику, и итоговый индекс равен `server_args.base_gpu_id + <сдвиг реплики> + …`. То есть при `--dp-size 2 --tp-size 2` реплики займут `{0,1}` и `{2,3}` от заданного основания.

Тот же расчет продублирован для вспомогательных процессов: `weight_cache/protocol.py:compute_local_gpu_id` (демоны кеша весов) и `disaggregation/encode_server.py` (`base_gpu_id + rank`).

### Взаимодействие с `CUDA_VISIBLE_DEVICES`

`gpu_id` — **логический** индекс, то есть позиция в списке `CUDA_VISIBLE_DEVICES`. При `CUDA_VISIBLE_DEVICES=4,5,6,7` и `--base-gpu-id 1` процесс сядет на физическую карту `5`. Это одна и та же арифметика, применяемая дважды, и путать слои опасно.

Полученный `gpu_id` проходит через `maybe_reindex_device_id` (`sglang/python/sglang/srt/utils/common.py`). По умолчанию (`SGLANG_ONE_VISIBLE_DEVICE_PER_PROCESS=False`) это no-op: дочерний процесс видит все карты и выбирает свою по индексу. Если переменную включить, родитель на время `mp.Process(...).start()` выставляет ребенку `CUDA_VISIBLE_DEVICES=<одна карта>`, а внутрь передает `gpu_id = 0` — тогда каждый scheduler видит ровно одно устройство.

## Значения и формат

- Целое ≥ 0. Отрицательное отвергается ассертом `base_gpu_id must be non-negative`.
- Значение отсчитывается от начала списка видимых устройств, а не от физических индексов NVML.
- `base_gpu_id + (tp_size_per_node - 1) * gpu_id_step` должно быть меньше числа видимых карт. Эта проверка не выполняется: превышение проявится как `RuntimeError: CUDA error: invalid device ordinal` при инициализации ранга.
- На многоузловом запуске значение задается для каждого узла отдельно и обычно одинаково (`0`), потому что `_calculate_rank_ranges` уже нарезал ранги по узлам.
- Значение — не «сколько карт занять». Число карт задает `--tp-size` (× `--pp-size` × `--dp-size`).

## Когда использовать

- Два и более экземпляра SGLang на одном хосте, когда разделять их через `CUDA_VISIBLE_DEVICES` неудобно (например, единая строка запуска в скрипте, различающаяся одним числом). Апстрим использует этот прием в примерах PD-disaggregation: prefill-воркер на `--base-gpu-id 0`, decode-воркер на `--base-gpu-id 1`.
- Часть карт занята посторонним процессом и его нельзя перезапустить — сдвиг дешевле, чем менять окружение. Для Ascend апстрим прямо рекомендует этот путь.
- Не использовать вместе с `CUDA_VISIBLE_DEVICES`, если можно обойтись только переменной: два слоя переиндексации одновременно — самый частый источник «занял не ту карту».
- **В arriero:** предпочитайте `CUDA_VISIBLE_DEVICES` в `env` инстанса. Preflight и оценка памяти считают набор занятых карт как первые `TP` элементов видимого списка (`selectedGpuDeviceRefs` в `apps/api/src/process/preflight-ktransformers.ts`) и **не читают `--base-gpu-id`**: с `--base-gpu-id 1` менеджер проверит бюджет пула первой карты, а процесс займет вторую. Резервации в `config/resources.json` окажутся привязаны не к тем пулам (`docs/RESOURCE_MANAGEMENT.md`).

## Влияние на производительность и память

- На объем занимаемой памяти не влияет: меняется только то, на каких картах она будет занята.
- Косвенно влияет на latency через топологию: сдвиг может развести ранги одной TP-группы по разным NVLink-доменам или PCIe-корням, и all-reduce станет дороже. На двухсокетных хостах он же меняет NUMA-узел, с которым карта имеет аффинность (см. `--numa-node`).
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--gpu-id-step`: второй множитель той же формулы; `--base-gpu-id 1 --gpu-id-step 2` при `--tp-size 2` даст карты `1` и `3`.
- `--tp-size` / `--pp-size`: определяют, сколько подряд идущих (с шагом) индексов будет занято от основания.
- `--dp-size`: добавляет автоматический сдвиг `tp_size * pp_size * gpu_id_step` на каждую реплику поверх `--base-gpu-id`.
- `--nnodes` / `--node-rank`: разбивают ранги по узлам до применения формулы; `--base-gpu-id` остается локальным для узла.
- `--numa-node`: индексируется тем же `gpu_id`, что получился из этой формулы, — список узлов должен быть достаточно длинным, чтобы индекс в него попал.
- `--use-ray`: Ray сам назначает карты акторам, и `gpu_id` из формулы используется только как запасной вариант, если Ray не выдал устройство.
- `--device`: формула применяется к устройствам выбранного класса; для CUDA логические индексы задаются `CUDA_VISIBLE_DEVICES`.

## Типовые проблемы и диагностика

- `RuntimeError: CUDA error: invalid device ordinal` на старте одного из рангов — основание плюс шаг вышли за число видимых карт. Считайте вручную: `base_gpu_id + (tp_size - 1) * gpu_id_step` должно быть `< len(CUDA_VISIBLE_DEVICES)`.
- `torch.OutOfMemoryError` сразу на загрузке весов при формально свободной карте — экземпляр сел на карту, занятую соседним процессом. Сверьте `nvidia-smi` с расчетом индексов.
- `The memory capacity is unbalanced. Some GPUs may be occupied by other processes.` (`_check_tp_memory_balance`) — тот же симптом на мультикарточном запуске: KV-пул будет посчитан по худшей карте.
- Что смотреть в логе: `Launch DP<n> starting at GPU #<id>.` (`sglang/python/sglang/srt/managers/data_parallel_controller.py`) при `--dp-size > 1`, `base_gpu_id=` в дампе `server_args=`, а фактическую привязку — `nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv` рядом с pid'ами процессов `sglang::scheduler*`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --port 30000 --base-gpu-id 0 --tensor-parallel-size 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --port 30001 --base-gpu-id 1 --tensor-parallel-size 1 --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/weight_cache/protocol.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
- `sglang/docs/docs/hardware-platforms/ascend-npus/faq.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
