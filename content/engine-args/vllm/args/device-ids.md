---
schema: 1
engine: vllm
primaryName: "--device-ids"
title: "--device-ids"
summary: Список карт, которые займёт этот инстанс, без правки `CUDA_VISIBLE_DEVICES`. Все GPU остаются видимыми процессу, поэтому топология (NVLink, привязка к NIC, NVML) видна целиком — в отличие от маскирования через переменную окружения.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-multi-port-external-lb
  - --distributed-executor-backend
  - --disable-custom-all-reduce
  - --gpu-memory-utilization
  - --numa-bind
  - --numa-bind-nodes
---

# --device-ids

## Кратко

`--device-ids "2,3"` говорит инстансу использовать физические карты 2 и 3. Это альтернатива `CUDA_VISIBLE_DEVICES=2,3` с одним содержательным отличием: переменная окружения **скрывает** остальные карты от процесса, а `--device-ids` — нет. Процесс продолжает видеть всю топологию, что нужно для привязки GPU к сетевой карте, для DeepGEMM и для корректных P2P/NVLink-проверок.

Флаг — главный инструмент разведения нескольких инстансов vLLM по картам одной машины. С Ray-исполнителем он не работает.

## Оригинальная справка

```text
Comma-separated physical GPU device IDs or UUIDs to use (e.g. --device-ids "2,3,5,7"). Avoids setting CUDA_VISIBLE_DEVICES, preserving full GPU topology visibility for GPU-NIC affinity and DeepGEMM. Note: has no effect with Ray executors; use Ray placement groups for GPU selection instead.
```

## Паспорт аргумента

- Флаги: `--device-ids`
- Группа argparse: `ParallelConfig`
- Тип значения: строка «через запятую», разбираемая в список `int | str`. В extract `type: null`, потому что argparse получает не именованный тип, а лямбду: каждый элемент режется по запятой, обрезается по пробелам и превращается в `int`, если состоит только из цифр, иначе остаётся строкой (UUID)
- Допустимые значения: не ограничены списком; ограничения проверяются в `EngineArgs._resolve_device_ids()` и в worker'е
- Значение по умолчанию: `null` — карты выбираются по порядку видимости
- Эффективное значение: список разрешается в **физические** идентификаторы и кладётся в `ParallelConfig.assigned_physical_gpu_ids`. При `--data-parallel-multi-port-external-lb` супервизор дополнительно режет список по локальным рангам; при Ray-исполнителе значение перекрывается тем, что выдала placement group
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: `create_engine_config` → `_resolve_device_ids()` → публикация отображения «логический ранг → физическая карта» в worker-процессе → выбор `torch.device`

## Что меняет в движке

**Разрешение значений** (`_resolve_device_ids`):

1. Пустой список или отсутствие флага ⇒ `None`.
2. `--distributed-executor-backend ray` ⇒ предупреждение `--device-ids has no effect when using the Ray executor. Use Ray placement groups for GPU selection instead.`
3. Дубликаты ⇒ `ValueError: --device-ids must not contain duplicates`.
4. Все элементы — строки (UUID) ⇒ каждый переводится в физический индекс. На NVML-платформе это `nvmlDeviceGetHandleByUUID` + `nvmlDeviceGetIndex`, то есть работают значения вида `GPU-abcd1234...`.
5. Смешение чисел и UUID ⇒ `ValueError: --device-ids must not mix integer IDs and UUIDs`.
6. Только числа **и задан** `CUDA_VISIBLE_DEVICES` ⇒ числа трактуются как индексы **внутри** видимого набора: при `CUDA_VISIBLE_DEVICES=4,5` значение `--device-ids "0,1"` даёт физические `[4, 5]`, а `--device-ids "0,2"` — `ValueError: --device-ids index 2 is out of range for CUDA_VISIBLE_DEVICES=4,5 (2 devices visible)`.
7. Только числа и `CUDA_VISIBLE_DEVICES` не задан ⇒ числа и есть физические идентификаторы.

**Использование в worker'е.** `set_assigned_physical_gpu_ids(...)` публикует отображение до инициализации устройства (оно нужно топологическим хелперам — привязке к NIC, P2P-проверкам, кэшу P2P). Затем worker проверяет `local_rank < len(assigned_physical_gpu_ids)` и, кроме бэкендов `ray`/`external_launcher`, ещё и `local_world_size <= len(...)`. Итоговое устройство выбирается как `torch.device(f"cuda:{logical_device_id_to_visible_device_id(local_rank)}")`.

**Порядок значим.** Логический ранг `i` получает `--device-ids[i]`, поэтому `"3,2"` и `"2,3"` — разные назначения. Это же отражено в ключе кэша P2P-проверок: перестановка того же набора карт считается другим отображением и получает отдельный файл кэша.

**Data parallel на CUDA.** При `mp`-исполнителе на CUDA список **не** режется по DP-рангам заранее: worker сам смещает `local_rank` на `dp_local_rank × (tp × pp)`. Значит, в `--device-ids` перечисляются карты для **всех** локальных DP-рангов сразу, ровно `data_parallel_size_local × tensor_parallel_size × pipeline_parallel_size` штук, в порядке рангов. Исключение — `--data-parallel-multi-port-external-lb`: там супервизор нарезает список сам и раздаёт срезы детям.

## Значения и формат

- Одна строка через запятую: `--device-ids "2,3,5,7"`. Пробелы вокруг элементов допускаются и обрезаются.
- Либо все элементы — целые, либо все — UUID; смешивать нельзя.
- Дубликаты запрещены.
- Отрицательные числа и любые нечисловые токены попадают в ветку UUID (проверка — `str.isdigit()`), поэтому `-1` не «специальное значение», а несуществующий UUID.
- Число элементов должно покрывать локальный `world_size` (с учётом DP, см. выше).
- Не задано ⇒ карты берутся по порядку из видимого набора: логический ранг `i` → видимая карта `i`.

## Когда использовать

- **Несколько инстансов vLLM на одной машине.** Первому `--device-ids "0,1"`, второму `--device-ids "2,3"`. Оба процесса видят всю топологию, но занимают только свои карты. В arriero это естественный способ развести инстансы по картам: каждый инстанс объявляет собственный memory-draw на нужный GPU-пул, и планировщик считает ёмкость по картам, а не по «одному GPU-пулу на хост» (`docs/RESOURCE_MANAGEMENT.md`).
- **Когда карты неравноценны.** Если на карте 0 висит дисплей или чужой процесс, `--device-ids "1,2"` явно уводит инстанс на свободные карты — в отличие от `--gpu-memory-utilization`, который лимитирует, но не выбирает.
- **Когда важна привязка GPU к NIC** (RDMA, multi-node EP): маскирование через `CUDA_VISIBLE_DEVICES` ломает соответствие между индексами CUDA и физической топологией PCIe, а `--device-ids` — нет.
- **Не используйте с Ray-исполнителем** — выбор карт там за placement group'ами.
- **Не смешивайте бездумно с `CUDA_VISIBLE_DEVICES`.** Комбинация работает, но семантика меняется: числа становятся индексами внутри видимого набора, а не физическими картами. Проще выбрать что-то одно.

## Влияние на производительность и память

- **VRAM.** Определяет, на каких картах вообще будет занята память. `--gpu-memory-utilization` применяется к **каждой** выбранной карте от её полного объёма, поэтому суммарный draw инстанса = доля × число карт в списке.
- **Скорость.** Косвенно, но существенно: выбор карт задаёт, какие линки окажутся между рангами TP-группы. Пара карт под одним NVLink-мостом даст кастомное all-reduce и высокий throughput; карты, разнесённые по разным корневым комплексам PCIe, — предупреждение `Custom allreduce is disabled because it's not supported on more than two PCIe-only GPUs.` и заметно более медленные коллективы.
- **Время старта.** Полная видимость топологии означает, что P2P-проба и NVML-запросы идут по всем картам; кэш P2P заводится отдельный на каждый набор/порядок карт.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`, `--pipeline-parallel-size`: их произведение задаёт минимальную длину списка на один DP-ранг.
- `--data-parallel-size-local`: при `mp` на CUDA умножает требуемую длину списка.
- `--data-parallel-multi-port-external-lb`: режет список по локальным рангам; при нехватке элементов даёт `--device-ids has N entries, but DP rank K needs devices [start, stop)`.
- `--distributed-executor-backend ray`: флаг игнорируется.
- `--disable-custom-all-reduce`: набор карт определяет, включится ли кастомное all-reduce вообще (связность и размер группы).
- `--gpu-memory-utilization`: применяется к каждой карте из списка.
- `--numa-bind`, `--numa-bind-nodes`: NUMA-узлы задаются «по одному на видимую карту», поэтому список карт и список узлов должны соответствовать друг другу.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --device-ids must not contain duplicates: [2, 2]`. **Лечение:** убрать повтор.
- **Симптом:** `ValueError: --device-ids must not mix integer IDs and UUIDs`. **Лечение:** оставить один формат.
- **Симптом:** `ValueError: --device-ids index 2 is out of range for CUDA_VISIBLE_DEVICES=4,5 (2 devices visible)`. **Причина:** числа трактуются как индексы внутри видимого набора. **Лечение:** нумеровать от нуля по видимому набору либо убрать `CUDA_VISIBLE_DEVICES`.
- **Симптом:** `AssertionError: local_rank N is out of bounds for assigned_physical_gpu_ids [...]` или `local_world_size (N) exceeds assigned_physical_gpu_ids count (M)`. **Причина:** карт в списке меньше, чем требует `tp × pp` (и `× data_parallel_size_local` при DP). **Лечение:** дополнить список.
- **Симптом:** `IndexError: device_id N is out of range for assigned_physical_gpu_ids [...]`. **Причина:** та же нехватка, поймана на уровне платформы.
- **Симптом:** `RuntimeError: Physical device N for logical device K is not visible in CUDA_VISIBLE_DEVICES=...` **Причина:** список указывает на карту, скрытую переменной окружения. **Лечение:** согласовать оба механизма.
- **Симптом:** предупреждение `--device-ids has no effect when using the Ray executor.` **Лечение:** placement group'ы Ray.
- **Подтверждение принятого значения:** `nvidia-smi` показывает процесс на ожидаемых картах; в логе видно `generating GPU P2P access cache in .../gpu_p2p_access_cache_for_<ключ>.json` с ключом из выбранных карт.

## Примеры

```bash
vllm serve /models/Qwen3-4B --device-ids "2,3" --tensor-parallel-size 2 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --device-ids "GPU-abcd1234-5678-90ab-cdef-1234567890ab" --gpu-memory-utilization 0.9 --max-model-len 8192
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/vllm/entrypoints/openai/dp_supervisor.py`
- `vllm/vllm/distributed/device_communicators/all_reduce_utils.py`
- `vllm/tests/engine/test_arg_utils.py`
- `docs/RESOURCE_MANAGEMENT.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
