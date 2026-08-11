---
schema: 1
engine: sglang
primaryName: "--gpu-id-step"
title: "--gpu-id-step"
summary: Шаг между индексами карт, назначаемых соседним TP-рангам. Нужен, чтобы разрядить экземпляр по устройствам, оставив промежутки другому процессу.
group: device
related:
  - --base-gpu-id
  - --tp-size
  - --pp-size
  - --dp-size
  - --device
  - --numa-node
  - --disable-custom-all-reduce
---

# --gpu-id-step

## Кратко

`--gpu-id-step` — множитель при `tp_rank` в формуле назначения устройства: с `2` экземпляр займет карты `0, 2, 4, …` вместо `0, 1, 2, …`. Как и `--base-gpu-id`, он работает с **логическими** индексами (после `CUDA_VISIBLE_DEVICES`) и нужен только при уплотнении нескольких экземпляров на одном хосте. Шаг больше единицы почти всегда ухудшает топологию коллективов: соседние ранги перестают быть соседями по NVLink.

## Оригинальная справка

```text
The delta between consecutive GPU IDs that are used. For example, setting it to 2 will use GPU 0,2,4,...
```

## Паспорт аргумента

- Флаги: `--gpu-id-step`
- Группа: `device`
- Тип значения: int
- Допустимые значения: `choices` нет; проверка `assert self.gpu_id_step >= 1, "gpu_id_step must be positive"` в `check_server_args`
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным, автоподбора нет
- Где объявлен: `ServerArgs.gpu_id_step`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: запуск scheduler-процессов, до `init_torch_distributed`

## Что меняет в движке

Значение входит ровно в одну формулу (`sglang/python/sglang/srt/entrypoints/engine.py`, тот же расчет в `managers/data_parallel_controller.py` и `weight_cache/protocol.py`):

```python
gpu_id = base_gpu_id
       + ((pp_rank % pp_size_per_node) * tp_size_per_node)
       + (tp_rank % tp_size_per_node) * gpu_id_step
```

Заметьте асимметрию: шаг умножается **только на `tp_rank`**. Слагаемое по `pp_rank` идет с коэффициентом `tp_size_per_node` и шага не учитывает, поэтому при `--pp-size > 1` и `--gpu-id-step > 1` наборы устройств разных PP-стадий начинают пересекаться. Это не проверяется — конфигурация просто окажется неверной.

Второе место, где шаг участвует, — раздача карт между DP-репликами: `DataParallelController.launch_dp_schedulers` увеличивает основание на `tp_size * pp_size * gpu_id_step` на каждую реплику, то есть шаг растягивает и расстояние между репликами.

Дальше `gpu_id` обрабатывается так же, как в `--base-gpu-id`: он проходит через `maybe_reindex_device_id` (no-op, пока не включен `SGLANG_ONE_VISIBLE_DEVICE_PER_PROCESS`), становится `local_rank` в `init_distributed_environment` и определяет `torch.device("cuda:<id>")` для группы.

## Значения и формат

- Целое ≥ 1. `0` и отрицательные отвергаются ассертом `gpu_id_step must be positive`.
- `1` — обычная плотная раскладка; это не «выключено», а нейтральный множитель.
- Верхняя граница не проверяется: `base_gpu_id + (tp_size_per_node - 1) * gpu_id_step` должно быть меньше числа видимых карт, иначе `invalid device ordinal` на инициализации ранга.
- Шаг применяется одинаково на всех узлах многоузлового запуска.

## Когда использовать

- Два экземпляра по одной карте каждый на 4-GPU хосте, где по каким-то причинам нужно чередование, а не разделение подряд: первый `--base-gpu-id 0 --gpu-id-step 2`, второй `--base-gpu-id 1 --gpu-id-step 2`. Практический смысл появляется, когда карты попарно связаны NVLink и нужно, чтобы каждый экземпляр получил по одному представителю пары.
- Нужно оставить свободными карты с определенными индексами (например, четные заняты другим фреймворком).
- Не поднимать шаг «на всякий случай» при `--tp-size > 1`: разрежение почти всегда разводит ранги по разным NVLink-доменам, и стоимость all-reduce на каждом слое вырастает.
- Не сочетать с `--pp-size > 1` без ручной проверки итоговых индексов — формула не защищает от пересечения наборов.
- **В arriero:** как и `--base-gpu-id`, этот аргумент не читается ни preflight'ом, ни оценкой памяти. Набор GPU-пулов инстанса менеджер выводит из `CUDA_VISIBLE_DEVICES` и `--tensor-parallel-size` (`docs/RESOURCE_MANAGEMENT.md`), поэтому разреженную раскладку он опишет неверно. Предпочтительный способ разделить карты между инстансами — разные `CUDA_VISIBLE_DEVICES`.

## Влияние на производительность и память

- Объем занимаемой памяти не меняется — меняется только распределение по картам.
- Latency коллективов: главный эффект. При `gpu_id_step > 1` ранги TP-группы с высокой вероятностью теряют прямые NVLink-связи; custom all-reduce отключится сам (`… is disabled because it's not supported on more than two PCIe-only GPUs`), и NCCL уйдет на PCIe-путь.
- На время старта не влияет (кроме разовой проверки P2P, если она включена `--enable-p2p-check`).

## Взаимодействие с другими аргументами

- `--base-gpu-id`: слагаемое той же формулы. `--base-gpu-id 1 --gpu-id-step 2 --tensor-parallel-size 2` → карты `1` и `3`.
- `--tp-size`: число слагаемых с шагом; именно `tp_rank` умножается на шаг.
- `--pp-size`: PP-слагаемое шаг не учитывает — см. предупреждение выше.
- `--dp-size`: расстояние между DP-репликами тоже умножается на шаг.
- `--disable-custom-all-reduce`: разреженная раскладка часто приводит к тому, что custom all-reduce и так отключается автоматически; явный флаг снимает предупреждение.
- `--numa-node`: список NUMA-узлов индексируется итоговым `gpu_id`, а не порядковым номером ранга, поэтому при шаге > 1 в списке появляются «дырки», которые все равно нужно заполнить.

## Типовые проблемы и диагностика

- `RuntimeError: CUDA error: invalid device ordinal` — шаг увел последний ранг за пределы видимых карт.
- Резкое падение decode-throughput после включения шага — ранги разъехались по PCIe. Подтверждение: строка `Custom allreduce is disabled because it's not supported on more than two PCIe-only GPUs` (или `… lacks GPU P2P capability`) в логе и `nvidia-smi topo -m` на хосте.
- Две PP-стадии на одной карте при `--pp-size > 1` — следствие того, что PP-слагаемое не умножается на шаг. Проверяется вручную по формуле; движок ошибку не сообщит.
- Что смотреть в логе: `gpu_id_step=` в дампе `server_args=`, `Launch DP<n> starting at GPU #<id>.` при `--dp-size > 1`, и фактическую привязку процессов `sglang::scheduler*` в `nvidia-smi`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --port 30000 --base-gpu-id 0 --gpu-id-step 2 --tensor-parallel-size 2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --port 30001 --base-gpu-id 1 --gpu-id-step 2 --tensor-parallel-size 2 --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce_utils.py`
- `sglang/python/sglang/srt/utils/common.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
