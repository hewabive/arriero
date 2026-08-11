---
schema: 1
engine: vllm
primaryName: "--offload-group-size"
title: "--offload-group-size"
summary: Включает prefetch-выгрузку весов и задает период раскладки: слои делятся на группы по N, и последние `--offload-num-in-group` слоев каждой группы живут в хостовой RAM с асинхронной подкачкой на GPU.
group: OffloadConfig
related:
  - --offload-num-in-group
  - --offload-prefetch-step
  - --offload-backend
  - --offload-params
  - --cpu-offload-gb
  - --gpu-memory-utilization
  - --pipeline-parallel-size
---

# --offload-group-size

## Кратко

`--offload-group-size` — выключатель prefetch-режима выгрузки весов. Любое значение больше нуля включает `PrefetchOffloader` (при `--offload-backend auto`), а само число задает период: слои трансформера нумеруются с нуля внутри своего PP-диапазона, и выгружаются **последние `--offload-num-in-group` слоев каждой группы из N**.

Доля выгруженных весов равна `num_in_group / group_size`. Регулярность здесь не косметика: именно невыгруженные слои между выгруженными дают вычислительное время, за которым прячется передача по PCIe. Чем меньше эта доля, тем полнее скрывается транзит.

## Оригинальная справка

```text
Group every N layers together. Offload last `offload_num_in_group`
layers of each group. Default is 0 (disabled).
Example: group_size=8, num_in_group=2 offloads layers 6,7,14,15,22,23,...
Unlike cpu_offload_gb, this uses explicit async prefetching to hide transfer
latency.
```

## Паспорт аргумента

- Флаги: `--offload-group-size`
- Группа argparse: `OffloadConfig`
- Тип значения: int (число слоев в группе)
- Допустимые значения: `>= 0` (валидация `ge=0`); дополнительно требуется `offload_num_in_group <= offload_group_size`, когда prefetch активен
- Значение по умолчанию: `Field(default=0, ge=0)`, то есть `0` — prefetch-выгрузка выключена
- Эффективное значение: не переопределяется; игнорируется при `--offload-backend uva`
- Где объявлен: `vllm/config/offload.py:PrefetchOffloadConfig.offload_group_size`
- Этап применения: `create_engine_config` (валидация) → `GPUModelRunner.__init__` (`create_offloader`) → построение слоев в `make_layers` → `post_init` в конце `load_model` → каждый forward

## Что меняет в движке

Отбор слоев в `PrefetchOffloader.wrap_modules` устроен ровно так:

```python
if module_index % self.group_size >= self.group_size - self.num_in_group:
```

`module_index` — порядковый номер слоя внутри диапазона данного pipeline-ранга, считая с нуля. Поэтому при `group_size=8, num_in_group=2` выгружаются индексы 6, 7, 14, 15, 22, 23 и так далее — как и написано в справке. При `--pipeline-parallel-size > 1` нумерация локальная для каждого ранга, а не глобальная для модели.

Для каждого отобранного слоя строится `_ModuleOffloader`: параметры (все, либо отфильтрованные `--offload-params`) переносятся в CPU-хранилище, а `module.forward` оборачивается так, что перед вычислением вызывается `torch.ops.vllm.wait_prefetch(hidden_states, index)`, а после — `torch.ops.vllm.start_prefetch(output, next_index)`, где `next_index = (index + prefetch_step) % число_выгруженных_слоев`. Копирование идет в отдельном `copy_stream` и синхронизируется CUDA-событиями, чтобы корректно попадать в захват CUDA graphs.

Слой, у которого после фильтра `--offload-params` не осталось ни одного подходящего параметра, из выгрузки исключается (`continue`) и не попадает в список `module_offloaders`. Из-за этого фактическая раскладка при активном фильтре может отличаться от арифметической.

В конце `load_model` вызывается `post_init()`, который аллоцирует `StaticBufferPool` и печатает итог. Это происходит **до** профилирования памяти, поэтому и сэкономленные веса, и занятый буферный пул корректно учитываются в бюджете `--gpu-memory-utilization`.

## Значения и формат

- Целое число слоев. `0` (дефолт) — режим выключен.
- Практически осмысленный диапазон — от `--offload-num-in-group + 1` и выше. Значение, равное `num_in_group`, означает «выгрузить все слои» и лишает механизм всякой возможности скрыть передачу.
- Значение больше числа слоев модели допустимо, но тогда выгрузится только хвост первой (единственной) группы, а на остаток слоев условие не сработает.
- Ошибки конфигурации ловятся до загрузки весов: `offload_num_in_group (X) must be <= offload_group_size (Y)` и `offload_prefetch_step (0) must be >= 1 when prefetch offloading is enabled (offload_group_size > 0)`.
- Специальных значений `auto`/`-1` нет.

## Когда использовать

- Модель не помещается в VRAM, но не хватает умеренно (единицы гигабайт), и есть запас VRAM под буферный пул — тогда prefetch дает существенно лучшую скорость, чем UVA-режим `--cpu-offload-gb`, при той же экономии.
- Начинайте с малой доли: `--offload-group-size 8 --offload-num-in-group 1` — это 12.5 % весов слоев, у оставшихся семи слоев обычно достаточно вычислительного времени, чтобы спрятать подкачку.
- Не используйте, если нужна экономия «сколько получится, но точно N гигабайт»: здесь задается доля слоев, а не объем; предсказать объем можно только через строку `Total GPU memory saved:` в логе.
- Не используйте на модели с неоднородными слоями, если не проверили результат замером: раскладка чисто периодическая и никак не учитывает, что слои бывают разного размера.
- Не комбинируйте с `--cpu-offload-gb` — при `auto` выигрывает prefetch, а UVA-поля молча игнорируются.

## Влияние на производительность и память

- **VRAM.** Уменьшается на объем выгруженных параметров (`Total GPU memory saved: X GB`) и одновременно увеличивается на размер буферного пула (`Static buffer pool: Y GB`). Чистая экономия — разность; при большой доле выгруженных слоев и большом `--offload-prefetch-step` она может оказаться много меньше ожидаемой.
- **RAM хоста.** Растет на объем выгруженных параметров; память пиннится (если `is_pin_memory_available()` и не выставлен `VLLM_WEIGHT_OFFLOADING_DISABLE_PIN_MEMORY=1`), то есть не свопится.
- **Decode.** Ключевая величина — успевает ли передача одного выгруженного слоя за время вычисления слоев, идущих до него. Оценка передачи: `объем_параметров_слоя / полоса_PCIe`; при практических ~25 GB/s на PCIe 4.0 x16 слой на 300 MiB требует порядка 12 мс, что на небольших моделях заметно больше времени вычисления одного слоя в decode. Поэтому при батче 1 скрыть передачу полностью удается редко, и просадка неизбежна — она просто меньше, чем у UVA.
- **Prefill.** Скрывается лучше: на крупном куске prefill вычисление слоя длится дольше, и подкачка успевает.
- **Время старта.** Растет: копирование весов в хост, аллокация пула, плюс перекомпиляция из-за изменения `OffloadConfig.compute_hash()`.
- **CUDA graphs.** Поддерживаются: копирование форкается через события, а `sync_prev_onload`/`join_after_forward` вызываются из обвязки захвата графов.

## Взаимодействие с другими аргументами

- `--offload-num-in-group`: вторая половина раскладки; вместе задают долю `num_in_group / group_size`. Должно выполняться `num_in_group <= group_size`.
- `--offload-prefetch-step`: глубина подкачки и одновременно число слотов буферного пула. При выгрузке подряд идущих слоев (`num_in_group > 1`) шаг меньше `num_in_group` не дает перекрытия для второго и последующих слоев группы.
- `--offload-backend`: `prefetch` или `auto`. При `uva` этот аргумент игнорируется с предупреждением.
- `--offload-params`: фильтр параметров внутри выгружаемых слоев; слои без совпадений выпадают из раскладки.
- `--cpu-offload-gb`: альтернативный механизм, не комбинируется.
- `--gpu-memory-utilization`: общий бюджет; и экономия, и буферный пул учитываются профилированием внутри него.
- `--pipeline-parallel-size`: индексы слоев локальны для ранга, поэтому одна и та же раскладка на разных рангах дает одинаковую долю, но разные глобальные номера слоев.

## Типовые проблемы и диагностика

- **Симптом:** `offload_num_in_group (4) must be <= offload_group_size (2)` при старте. **Лечение:** увеличить группу или уменьшить число выгружаемых слоев в ней.
- **Симптом:** `offload_prefetch_step (0) must be >= 1 when prefetch offloading is enabled (offload_group_size > 0)`. **Лечение:** задать `--offload-prefetch-step` не меньше 1.
- **Симптом:** VRAM почти не освободилась. **Причина:** буферный пул съел экономию. **Проверка:** сравнить `Total GPU memory saved:` и `Static buffer pool:` в строке `[PrefetchOffloader] Initialized ...`. **Лечение:** уменьшить `--offload-prefetch-step` или долю выгруженных слоев.
- **Симптом:** выгружено меньше слоев, чем ожидалось по арифметике. **Причина:** фильтр `--offload-params` исключил слои без совпадений. **Проверка:** число модулей в той же строке `Initialized N modules`.
- **Симптом:** скорость decode упала намного сильнее, чем доля выгруженных весов. **Причина:** передача не скрывается — либо доля слишком велика, либо `--offload-prefetch-step` меньше `--offload-num-in-group`. **Лечение:** снизить `--offload-num-in-group` до 1 или поднять шаг.
- **Подтверждение принятого значения:** `Offloader set to PrefetchOffloader` и итоговая строка `[PrefetchOffloader] Initialized N modules. Total GPU memory saved: X GB, Static buffer pool: Y GB (group_size=N, num_in_group=M, prefetch_step=K, mode=cpu)`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --offload-group-size 8 --offload-num-in-group 1 --offload-prefetch-step 1
```

```bash
vllm serve /models/Qwen3-4B --offload-backend prefetch --offload-group-size 4 --offload-num-in-group 2 --offload-prefetch-step 2 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/offload.py`
- `vllm/vllm/model_executor/offloader/prefetch.py`
- `vllm/vllm/model_executor/offloader/base.py`
- `vllm/vllm/model_executor/models/utils.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/config/vllm.py`
- `vllm/tests/basic_correctness/test_cpu_offload.py`
