---
schema: 1
engine: vllm
primaryName: "--cpu-offload-gb"
title: "--cpu-offload-gb"
summary: Бюджет в GiB на выгрузку весов модели в хостовую RAM через UVA — GPU читает эти веса напрямую по PCIe в каждом forward. Позволяет запустить модель, которая не помещается в VRAM, ценой падения скорости decode в разы.
group: OffloadConfig
related:
  - --offload-backend
  - --cpu-offload-params
  - --offload-group-size
  - --gpu-memory-utilization
  - --kv-offloading-size
  - --enforce-eager
  - --tensor-parallel-size
  - --quantization
  - --max-model-len
---

# --cpu-offload-gb

## Кратко

`--cpu-offload-gb` включает UVA-выгрузку **весов** модели: параметры переезжают в pinned-память хоста, а на устройстве остается только UVA-view на них. GPU-копии нет вообще, поэтому экономия VRAM равна выгруженному объему один в один.

Плата за это — не разовая, а на каждый forward: выгруженные веса читаются через PCIe при каждом шаге генерации. Это не «виртуальное расширение VRAM», как обещает справка, а обмен пропускной способности памяти на емкость.

Аргумент не имеет отношения к `--kv-offloading-size`: тот выгружает блоки KV-cache, этот — веса. Механизмы независимы и суммируются по потреблению хостовой RAM.

## Оригинальная справка

```text
The space in GiB to offload to CPU, per GPU. Default is 0, which means
no offloading. Intuitively, this argument can be seen as a virtual way to
increase the GPU memory size. For example, if you have one 24 GB GPU and
set this to 10, virtually you can think of it as a 34 GB GPU. Then you can
load a 13B model with BF16 weight, which requires at least 26GB GPU memory.
Note that this requires fast CPU-GPU interconnect, as part of the model is
loaded from CPU memory to GPU memory on the fly in each model forward pass.
This uses UVA (Unified Virtual Addressing) for zero-copy access.
```

## Паспорт аргумента

- Флаги: `--cpu-offload-gb`
- Группа argparse: `OffloadConfig`
- Тип значения: float, единица измерения — GiB (двоичные, `× 1024³`)
- Допустимые значения: `>= 0` (валидация `ge=0`), верхней границы нет
- Значение по умолчанию: `Field(default=0, ge=0)`, то есть `0` — выгрузка выключена
- Эффективное значение: не переопределяется, но **игнорируется**, если выбран prefetch-backend (`--offload-backend prefetch`, либо `auto` при `--offload-group-size > 0`)
- Где объявлен: `vllm/config/offload.py:UVAOffloadConfig.cpu_offload_gb`
- Этап применения: разбор CLI → `create_engine_config` (сборка `OffloadConfig`) → создание offloader'а в `GPUModelRunner.__init__` → загрузка модели → профилирование памяти → каждый forward

## Что меняет в движке

1. `create_engine_config()` кладет значение в `OffloadConfig.uva.cpu_offload_gb`.
2. `GPUModelRunner.__init__` вызывает `create_offloader(offload_config)` (`vllm/model_executor/offloader/base.py`). При backend `auto` и `offload_group_size == 0` ненулевой `cpu_offload_gb` выбирает `UVAOffloader` с бюджетом `int(cpu_offload_gb × 1024³)` байт.
3. Модель строится через `make_layers()` (`vllm/model_executor/models/utils.py`), который пропускает генератор слоев через `get_offloader().wrap_modules(...)`. **Выгружаются только модули, созданные через `make_layers`** — это блоки трансформера внутри PP-диапазона данного ранга. Эмбеддинги, `lm_head`, визуальные энкодеры и любые модели, не использующие `make_layers`, остаются на GPU целиком.
4. `UVAOffloader._maybe_offload_to_cpu` идет по слоям **по порядку, с первого**, и по параметрам внутри слоя, пока накопленный объем не достигнет бюджета. Каждый параметр копируется в CPU, пиннится и заменяется на CUDA-view (`torch.ops._C.get_cuda_view_from_cpu_tensor`). Выгрузка **по параметру, а не по слою**: слой на границе бюджета может оказаться выгружен частично.
5. Дальше GPU читает эти веса напрямую из хостовой памяти при каждом forward. Явных копий H2D нет — этим UVA отличается от prefetch-режима.

Если UVA недоступна (`is_uva_available()` — по сути наличие pinned-памяти) или выключена через `VLLM_WEIGHT_OFFLOADING_DISABLE_UVA=1`, включается запасной путь: параметры просто остаются на CPU, а `module.forward` оборачивается в `functional_call`, который копирует весь `state_dict` слоя на устройство при каждом вызове. Этот путь **несовместим с CUDA graphs** — в апстрим-тесте `tests/basic_correctness/test_cpu_offload.py` он запускается только вместе с `--enforce-eager`.

Взаимодействие с бюджетом памяти: выгрузка происходит во время `load_model`, то есть **до** `Worker.determine_available_memory()`. Профилирование видит уже уменьшенный вес модели, и весь освободившийся объем уходит под KV-cache в рамках `--gpu-memory-utilization`. Отдельно резервировать ничего не нужно.

`OffloadConfig.compute_hash()` входит в ключ кэша компиляции (`VllmConfig.compute_hash`), поэтому изменение значения вызывает повторную компиляцию модели при следующем старте.

## Значения и формат

- Дробное число GiB: `--cpu-offload-gb 8`, `--cpu-offload-gb 10.5`. Суффиксы (`8G`) **не** поддерживаются — тип поля `float`, парсер применяет обычный `float()`.
- `0` (дефолт) — выгрузка выключена; offloader'ом становится `NoopOffloader`.
- Отрицательные значения отвергаются валидацией `ge=0`.
- Это **лимит на GPU, а не на инстанс**: каждый TP-ранг применяет то же число к своей карте. При `--tensor-parallel-size 4 --cpu-offload-gb 10` в pinned-памяти хоста окажется 40 GiB.
- Бюджет — верхняя граница, а не цель. Если суммарный объем весов слоев меньше значения, выгрузится столько, сколько есть, без ошибки.

## Когда использовать

- Модель не помещается в VRAM, а вторая карта, квантизация и модель поменьше по каким-то причинам недоступны, при этом нагрузка — редкие одиночные запросы, где секунды на токен приемлемы.
- Нужно выгрузить строго определенный класс параметров (обычно MoE-эксперты) — тогда вместе с `--cpu-offload-params`, иначе выгрузится «первое, что попалось».
- **Не используйте для ускорения или для выигрыша по throughput.** Единственное, что дает аргумент, — емкость.
- **Не используйте, если есть вариант с квантизацией или меньшей моделью.** Квантизация в INT8/FP8 уменьшает веса примерно вдвое и оставляет их в VRAM с полосой в сотни GB/s; выгрузка того же объема ставит его за PCIe с полосой порядка 25 GB/s. При равной экономии VRAM квантизация быстрее на порядок, и `--quantization` почти всегда правильный первый ход.
- Не рассчитывайте выгрузить «немножко»: даже 1-2 GiB на горячем пути decode заметно бьют по скорости, потому что читаются каждый шаг.

## Влияние на производительность и память

- **VRAM.** Уменьшается ровно на выгруженный объем; строка `Total CPU offloaded parameters: <число>` печатается на INFO (значение в GiB, единица в строке не указана). Освободившееся уходит в KV-cache через профилирование.
- **RAM хоста.** Растет на выгруженный объем, и это **pinned-память**: она не свопится и вычитается из доступной ядру. На хосте с 32 GiB RAM выгрузка 20 GiB — почти гарантированный OOM-killer при первом же всплеске другой активности.
- **Decode.** Основная плата. Каждый шаг генерации читает выгруженные веса через PCIe. Оценка снизу: `время_на_шаг ≈ выгружено_байт / полоса_PCIe`. При 10 GiB и практических ~25 GB/s на PCIe 4.0 x16 это порядка 0.4 с на forward, то есть потолок около 2-3 токен/с независимо от модели и от батча размера 1.
- **Prefill.** Страдает заметно меньше: та же передача обслуживает весь батч токенов сразу, поэтому относительная стоимость падает пропорционально размеру куска prefill.
- **Время старта.** Растет: копирование весов в хост и пиннинг занимают время, плюс смена значения инвалидирует кэш torch.compile.
- **CUDA graphs.** На штатном UVA-пути захват графов работает. На запасном пути (`VLLM_WEIGHT_OFFLOADING_DISABLE_UVA=1`) нужен `--enforce-eager`.

## Взаимодействие с другими аргументами

- `--offload-backend`: явный выбор реализации. `uva` — этот аргумент; `prefetch` — полностью его игнорирует (с предупреждением `UVA offload fields are set but offload_backend='prefetch'. UVA settings will be ignored.`).
- `--cpu-offload-params`: фильтр по именам параметров. Без него выгружается все подряд с первого слоя до исчерпания бюджета.
- `--offload-group-size`: включает альтернативный prefetch-механизм. При `auto` и обоих ненулевых значениях выигрывает prefetch, о чем выдается предупреждение.
- `--gpu-memory-utilization`: бюджет, из которого выгрузка высвобождает долю весов в пользу KV-cache. Отдельно ничего повышать не нужно — эффект появляется сам.
- `--kv-offloading-size`: другой механизм и другие данные (блоки prefix cache вместо весов). Аргументы независимы, но конкурируют за одну и ту же хостовую RAM и одну и ту же шину PCIe.
- `--tensor-parallel-size`: значение применяется на каждый ранг; шардирование весов обычно лучше выгрузки, если карты есть.
- `--quantization`: прямая альтернатива по экономии VRAM без потери полосы.
- `--max-model-len`: если цель — просто уместить модель, сначала стоит урезать контекст; это дешевле по скорости, чем выгрузка весов.
- `--enforce-eager`: обязателен на запасном не-UVA пути.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но VRAM не уменьшилась и в логе нет `Offloader set to UVAOffloader`. **Причина:** активен prefetch-backend (задан `--offload-group-size` или `--offload-backend prefetch`). **Проверка:** строка `Offloader set to PrefetchOffloader` и предупреждение об игнорировании UVA-полей. **Лечение:** убрать prefetch-поля или задать `--offload-backend uva` явно.
- **Симптом:** VRAM уменьшилась намного меньше заданного значения. **Причина:** суммарный вес слоев, доступных `make_layers`, меньше бюджета, либо `--cpu-offload-params` отфильтровал почти все. **Проверка:** фактическая величина в строке `Total CPU offloaded parameters:`.
- **Симптом:** скорость генерации упала в разы, GPU почти простаивает. **Причина:** ожидаемое поведение — упор в PCIe. **Проверка:** `nvidia-smi` показывает низкую утилизацию SM при работающем запросе. **Лечение:** уменьшить значение, перейти на квантизацию или на меньшую модель.
- **Симптом:** хост уходит в своп или процесс убивает OOM-killer, хотя VRAM в порядке. **Причина:** pinned-память не свопится и вычитается из RAM целиком. **Лечение:** снизить значение с учетом того, что при TP оно умножается на число рангов.
- **Симптом:** падение или ошибка при `Capturing CUDA graphs`. **Причина:** выставлен `VLLM_WEIGHT_OFFLOADING_DISABLE_UVA=1`, а `--enforce-eager` нет. **Лечение:** добавить `--enforce-eager` либо вернуть UVA.
- **Симптом (WSL2):** предупреждение про page-locked memory и подвисание всей системы. **Причина:** Windows ограничивает объем pinned-памяти по всей системе; движок печатает подробное предупреждение при сочетании `--cpu-offload-gb` с CUDA graphs под WSL (`vllm/platforms/cuda.py`). **Лечение:** держать значение малым либо не использовать выгрузку под WSL.
- **Симптом (arriero):** оценка памяти инстанса не изменилась после включения выгрузки. **Причина:** оценщик `vllm-gpu-util` считает draw от `--gpu-memory-utilization` и не моделирует выгрузку весов; хостовая RAM в нем вообще не оценивается. **Лечение:** резерв хостовой RAM под pinned-буфер объявлять вручную — см. `docs/MEMORY_ESTIMATION.md` (arriero).

## Примеры

```bash
vllm serve /models/Qwen3-4B --cpu-offload-gb 4 --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --cpu-offload-gb 6 --cpu-offload-params experts --offload-backend uva
```

## Источники

- `vllm/vllm/config/offload.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/model_executor/offloader/base.py`
- `vllm/vllm/model_executor/offloader/uva.py`
- `vllm/vllm/model_executor/models/utils.py`
- `vllm/vllm/utils/platform_utils.py`
- `vllm/vllm/utils/torch_utils.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/tests/basic_correctness/test_cpu_offload.py`
- `docs/MEMORY_ESTIMATION.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
