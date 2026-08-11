---
schema: 1
engine: sglang
primaryName: "--offload-mode"
title: "--offload-mode"
summary: Куда именно уезжают выгруженные веса во второй схеме оффлоада: закрепленная RAM, разделяемая между DP-рангами RAM, шарды на других GPU или заглушка `meta`. Список значений в argparse не объявлен — опечатка вылезает как `KeyError` при загрузке весов.
group: exec.offload
related:
  - --offload-group-size
  - --offload-num-in-group
  - --offload-prefetch-step
  - --cpu-offload-gb
  - --dp-size
  - --tp-size
  - --moe-runner-backend
---

# --offload-mode

## Кратко

Значение читается только второй схемой оффлоада, то есть при `--offload-group-size` больше нуля. Оно выбирает класс, который отвечает за хранение и возврат параметров: `cpu` (закрепленная память хоста, копия на каждый ранг), `shm_cpu` (одна копия в разделяемой памяти хоста на все DP-ранги), `sharded_gpu` (параметр разрезан по DP-рангам и собирается перед использованием) и `meta` (веса выбрасываются, тензоры создаются пустыми — только для отладки).

Список значений нигде не объявлен как `choices`: реестр живет в `_BaseParamOffloader.create` как обычный словарь, поэтому неизвестная строка дает `KeyError` уже на этапе построения модели, без внятного сообщения.

## Оригинальная справка

```text
Mode of offloading.
```

## Паспорт аргумента

- Флаги: `--offload-mode`
- Группа: `exec.offload`
- Тип значения: str
- Допустимые значения: в argparse не ограничены (`choices: null` в extract). Фактический реестр в `_BaseParamOffloader.create`: `meta`, `cpu`, `shm_cpu`, `sharded_gpu`
- Значение по умолчанию: `cpu`
- Эффективное значение: совпадает с заданным; автоподбора нет
- Где объявлен: `ServerArgs.offload_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; фактически часть экспериментального контура — три из четырех режимов имеют жесткие ограничения по параллелизму
- Этап применения: создание `OffloaderV2` (инициализация `NaiveDistributed`/разделяемой памяти) → построение слоев (перенос параметров) → `post_init` → каждый forward

## Что меняет в движке

### Режимы

- **`cpu`** (`_CpuParamOffloader`) — параметр переносится в закрепленную память хоста (`_move_param_to_cpu(pin_memory=True)`), обратно поднимается через `param.to("cuda", non_blocking=True)`. Единственный режим, работающий при любом параллелизме. Он же выставляет `forbid_copy_engine_usage = True`, из-за чего MoE-путь DeepGEMM переключается на `copy_list_to_gpu_no_ce` вместо обычного pinned-копирования: копировальный движок занят оффлоадом, и его использование в другом месте создавало бы конкуренцию.
- **`shm_cpu`** (`_ShmCpuParamOffloader`) — ранг 0 кладет параметр в хостовую разделяемую память (`HostSharedMemoryManager`), остальные ранги переводят свой на `meta`. Одна копия весов на всю DP-группу вместо копии на ранг. Требует `--tp-size 1` и непрерывного (contiguous) тензора.
- **`sharded_gpu`** (`_ShardedGpuParamOffloader`) — параметр остается на GPU, но разрезается по DP-рангам; перед использованием собирается обратно. Обмен идет по NVLink/PCIe между картами, а не с хостом. Требует `--tp-size 1`.
- **`meta`** (`_MetaParamOffloader`) — параметр переводится на `meta`-устройство, а `create_device_tensor` возвращает `torch.empty_like`. Веса теряются, генерация бессмысленна; режим существует для отладки и для измерения потолка экономии VRAM.

### Инициализация распределенного слоя

Для `shm_cpu` и `sharded_gpu` конструктор `OffloaderV2` поднимает `NaiveDistributed` с рангом `dp_rank`, размером `dp_size` и рандеву-точкой `/tmp/<SGLANG_RUN_ID>`, где `SGLANG_RUN_ID` — уникальный идентификатор запуска, выставляемый в `entrypoints/engine.py`. Для `shm_cpu` дополнительно создается `HostSharedMemoryManager` с тем же базовым именем. Оба режима содержат ассерт `not yet support tp_size!=1`.

## Значения и формат

- Строка; проверки на старте нет. Опечатка вроде `Cpu` или `shm-cpu` пройдет разбор и упадет `KeyError` при построении модели.
- `cpu` — значение по умолчанию и единственный режим без ограничений по параллелизму.
- `shm_cpu` и `sharded_gpu` осмысленны только при `--dp-size` больше 1 и `--tp-size 1`.
- `meta` не даёт корректных ответов — не используйте его в рабочем контуре.
- Без `--offload-group-size` больше нуля значение не читается вовсе (первая схема, `--cpu-offload-gb`, его не смотрит).

## Когда использовать

- `cpu` — единственный вменяемый выбор на однокарточном хосте вроде квалифицированного профиля arriero: делить веса не с кем, шардировать некуда.
- `shm_cpu` — когда на одном хосте запущено несколько DP-реплик одной модели: экономит кратно числу реплик RAM хоста.
- `sharded_gpu` — когда карт несколько, суммарной VRAM хватает, но на одну карту модель не влезает, а полноценный тензорный параллелизм по каким-то причинам не подходит.
- `meta` — только чтобы измерить, сколько VRAM освободит выбранная конфигурация групп, не тратя время на реальные копии.
- Не задавать значение «на всякий случай»: без второй схемы оффлоада оно мертво, а с ней требует согласования с `--tp-size` и `--dp-size`.

## Влияние на производительность и память

- VRAM: `cpu` и `shm_cpu` освобождают весь объем выгруженного (минус предвыборка); `sharded_gpu` освобождает `(1 − 1/dp_size)` от него; `meta` — весь объем, но без работоспособности.
- RAM хоста: `cpu` — закрепленная копия на каждый ранг; `shm_cpu` — одна копия на всю DP-группу; `sharded_gpu` и `meta` — ничего.
- Время старта: `shm_cpu` добавляет барьер синхронизации рангов, `sharded_gpu` — scatter параметров.
- Latency: у `cpu` и `shm_cpu` цена шага — копирование по PCIe; у `sharded_gpu` — межкарточный обмен, который обычно быстрее, если карты соединены NVLink.
- MoE-путь: в режиме `cpu` DeepGEMM отказывается от копировального движка (`forbid_copy_engine_usage`), что чуть меняет профиль мелких хостовых передач.

## Взаимодействие с другими аргументами

- `--offload-group-size`: включает схему; без него значение не читается.
- `--offload-num-in-group` / `--offload-prefetch-step`: определяют объем и резидентность выгруженного, режим — только способ хранения.
- `--tp-size`: `shm_cpu` и `sharded_gpu` требуют `1`.
- `--dp-size`: задает число участников для `shm_cpu`/`sharded_gpu`.
- `--cpu-offload-gb`: другая схема; этот аргумент к ней не относится.
- `--moe-runner-backend`: в режиме `cpu` DeepGEMM-путь переключается на копирование без copy engine.

## Типовые проблемы и диагностика

- `KeyError: 'shm-cpu'` (или любая другая опечатка) при построении модели — значение не из реестра `meta`/`cpu`/`shm_cpu`/`sharded_gpu`.
- `AssertionError: not yet support tp_size!=1` — режим `shm_cpu`/`sharded_gpu` при тензорном параллелизме.
- `AssertionError: not yet support non-contiguous tensor …` — параметр модели не непрерывен; для `shm_cpu`/`sharded_gpu` это блокирующее условие.
- `KeyError: 'SGLANG_RUN_ID'` — офлоадер создан вне обычного запуска сервера (переменная выставляется в `entrypoints/engine.py`).
- Модель отвечает бессмыслицей — вероятно, остался `--offload-mode meta`.
- Что смотреть в логе: строки `[offloader] offload module_index=… submodule=… params=[…]` при построении и `[offloader] post_init … memory_allocated=…` для `sharded_gpu`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V2-Lite --offload-group-size 4 --offload-num-in-group 1 --offload-mode cpu
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V2-Lite --offload-group-size 4 --offload-num-in-group 1 --offload-mode shm_cpu --tp-size 1 --dp-size 2
```

## Источники

- `sglang/python/sglang/srt/utils/offloader.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/layers/moe/moe_runner/deep_gemm.py`
- `sglang/python/sglang/srt/utils/host_shared_memory.py`
- `sglang/test/registered/npu/basic_function/offloading/test_npu_offload_modes.py`
