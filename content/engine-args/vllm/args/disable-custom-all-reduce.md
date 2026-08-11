---
schema: 1
engine: vllm
primaryName: "--disable-custom-all-reduce"
title: "--disable-custom-all-reduce"
summary: Выключает собственное ядро all-reduce vLLM для TP-группы и оставляет только NCCL. Практический смысл — заглушить предупреждения и P2P-пробу на машинах, где кастомное ядро все равно не применяется.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --prefill-context-parallel-size
  - --distributed-executor-backend
  - --device-ids
  - --data-parallel-size
  - --gpu-memory-utilization
  - --enforce-eager
---

# --disable-custom-all-reduce

## Кратко

vLLM несёт собственное ядро all-reduce поверх CUDA IPC, которое на малых тензорах быстрее NCCL. `--disable-custom-all-reduce` его отключает, и коллективы TP-группы идут только через PyNCCL.

Флаг имеет смысл **только когда TP-группа больше одного ранга**: кастомное all-reduce подключается исключительно к группе с именем `tp` (`if "tp" not in unique_name: use_custom_allreduce = False`). На одиночной карте флаг не делает ничего.

## Оригинальная справка

```text
Disable the custom all-reduce kernel and fall back to NCCL.
```

## Паспорт аргумента

- Флаги: `--disable-custom-all-reduce`, `--no-disable-custom-all-reduce`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо `--no-...`; «не задан» = `False`, то есть кастомное ядро **включено**
- Значение по умолчанию: `false`
- Эффективное значение: принудительно становится `true` в трёх местах — при `VLLM_BATCH_INVARIANT`, когда `current_platform.use_custom_allreduce()` ложно (лог debug `Disabled the custom all-reduce kernel because it is not supported on current platform.`), и на CPU-worker'е. Кроме того, сам объект `CustomAllreduce` может отключиться уже после создания по нескольким рантайм-проверкам
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.disable_custom_all_reduce`
- Этап применения: инициализация распределённого окружения worker'а (`set_custom_all_reduce(not disable_custom_all_reduce)`) → построение коммуникатора TP-группы

## Что меняет в движке

`gpu_worker.init_worker_distributed_environment` вызывает `set_custom_all_reduce(not parallel_config.disable_custom_all_reduce)`, а `CudaCommunicator` читает получившийся флаг только для группы `tp`. Дальше в цепочке диспетчеризации `all_reduce` участвуют, в порядке приоритета: `NCCL_SYMM_MEM`, `QUICK_REDUCE` (ROCm), `FLASHINFER`, `AITER_CUSTOM`, `CUSTOM`, `SYMM_MEM`, `PYNCCL`. Флаг убирает из этого списка `CUSTOM` (а на ROCm — заодно и `AITER_CUSTOM`, который включается только вместе с кастомным all-reduce).

**Поддержка платформой.** `use_custom_allreduce()` истинно на CUDA всегда; на ROCm — только для MI300/MI350 (`gfx94`, `gfx95`); базовая реализация возвращает `False`. Если платформа не поддерживает, флаг выставляется сам, и передавать его вручную не нужно.

**Самоотключение в рантайме.** Даже с включённым флагом `CustomAllreduce` откажется работать и напишет в лог, если:

- отсутствует библиотека кастомного all-reduce — `Custom allreduce is disabled because of missing custom allreduce library`;
- размер группы не входит в `[2, 4, 6, 8, 16]` — `Custom allreduce is disabled due to an unsupported world size: %d. Supported world sizes: ... To silence this warning, specify disable_custom_all_reduce=True explicitly.`;
- карт больше двух и они соединены только через PCIe (нет полной связности NVLink) — `Custom allreduce is disabled because it's not supported on more than two PCIe-only GPUs. To silence this warning, specify disable_custom_all_reduce=True explicitly.`;
- провалилась проверка P2P — `Custom allreduce is disabled because your platform lacks GPU P2P capability or P2P test failed. To silence this warning, specify disable_custom_all_reduce=True explicitly.`;
- группа многоузловая и MNNVL multicast недоступен — `Custom collectives are disabled because this multi-node group does not support MNNVL multicast.`

Именно эти три «To silence this warning» и есть основной практический повод задавать флаг: он ничего не ломает, но убирает шум.

**Стоимость P2P-пробы.** Проверка `gpu_p2p_access_check` запускается один раз на комбинацию видимых карт: локальный rank 0 порождает подпроцесс, прогоняет все пары устройств и кладёт результат в `$VLLM_CACHE_ROOT/gpu_p2p_access_cache_for_<ключ>.json` (`generating GPU P2P access cache in %s`, затем `reading GPU P2P access cache from %s`). Ключ — это `CUDA_VISIBLE_DEVICES` либо список физических карт, назначенных через `--device-ids`. `--disable-custom-all-reduce` убирает эту пробу со старта целиком; альтернатива — переменная окружения `VLLM_SKIP_P2P_CHECK`, которая доверяет отчёту драйвера без прогона.

Поле входит в `ignored_factors` `ParallelConfig.compute_hash()`, поэтому значение может различаться между DP-рангами, не ломая проверку согласованности конфигураций.

## Значения и формат

- Булев переключатель без аргумента; `--no-disable-custom-all-reduce` возвращает `False` (полезно, если значение приходит из `--config`-файла).
- На `--tensor-parallel-size 1` флаг инертен: TP-группы из одного ранга нет, `CustomAllreduce` не создаётся.
- Флаг не влияет на группы `pp`, `dp`, `ep`, `dcp` — там кастомного all-reduce нет по построению.

## Когда использовать

- **Несколько карт без NVLink** (типовой сервер с PCIe-подключением, `-tp 4`): кастомное ядро всё равно отключится, а лог будет предупреждать при каждом старте. Явный флаг убирает предупреждение и P2P-пробу.
- **Стабильность важнее пары процентов латентности**: кастомное ядро использует CUDA IPC-буферы и P2P; при подозрении на зависания или порчу данных в коллективах это первое, что стоит выключить, чтобы разделить проблему.
- **Несколько инстансов vLLM на одной машине**: сама по себе изоляция обеспечивается разными наборами карт, а не этим флагом — IPC-буферы создаются внутри TP-группы одного инстанса. Но флаг убирает P2P-пробу, которая при одновременном старте нескольких инстансов порождает подпроцессы и разогревает разные кэш-файлы (ключ кэша зависит от набора видимых карт), удлиняя холодный старт.
- **Не отключайте на 2–8 картах с NVLink**: там кастомное ядро реально быстрее NCCL на характерных для декодирования маленьких тензорах.
- **Не используйте как «лекарство от OOM»**: экономия — десятки мегабайт на ранг, это не тот порядок.

## Влияние на производительность и память

- **VRAM.** Кастомное all-reduce резервирует на каждый ранг TP-группы: метаданные + рабочий буфер (`meta_size()` + 8 МиБ), «legacy»-буфер `max(8, 2, 16) = 16` МиБ и `rank_data` на 8 МиБ, плюс staging для MNNVL. Порядок — десятки мегабайт на карту; они попадают в измеренную профилировщиком non-KV память и косвенно уменьшают KV-cache при фиксированном `--gpu-memory-utilization`.
- **Latency.** Основной эффект. На малых тензорах (декодирование, `--max-num-seqs` небольшой) кастомное ядро ощутимо быстрее NCCL; на больших тензорах диспетчер и так уходит в PyNCCL, поэтому отключение там почти не заметно.
- **Время старта.** Отключение экономит P2P-пробу (подпроцесс на все пары карт) при первом запуске для данного набора устройств.
- **CUDA graphs.** Кастомное all-reduce умеет захватываться в графы; при `--enforce-eager` графов нет, и разница между бэкендами становится чище видна в профиле.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`: единственный флаг, делающий этот значимым. Кастомное ядро поддерживает размеры группы `2, 4, 6, 8, 16`.
- `--pipeline-parallel-size`, `--prefill-context-parallel-size`: увеличивают `world_size`, но собственных кастомных коллективов не получают.
- `--device-ids`: определяет набор физических карт, а значит и результат проверки полной связности и ключ кэша P2P.
- `--distributed-executor-backend`: при `uni` (одна карта) флаг бессмыслен; при `ray` набор карт задаётся Ray.
- `--gpu-memory-utilization`: буферы кастомного ядра вычитаются из того же бюджета, что и KV-cache.
- `--data-parallel-size`: значение может отличаться между рангами — оно исключено из хеша конфигурации.

## Типовые проблемы и диагностика

- **Симптом:** при каждом старте `Custom allreduce is disabled because it's not supported on more than two PCIe-only GPUs.` **Причина:** больше двух карт без полной NVLink-связности. **Лечение:** добавить `--disable-custom-all-reduce`, чтобы убрать предупреждение; на производительность это не повлияет, ядро и так не работало.
- **Симптом:** `Custom allreduce is disabled due to an unsupported world size: 3.` **Причина:** `-tp 3`. **Лечение:** либо степень двойки/поддерживаемый размер, либо явное отключение.
- **Симптом:** долгий первый старт с строкой `generating GPU P2P access cache in ...`. **Причина:** проба P2P по всем парам карт. **Лечение:** это разовая операция на набор карт; можно снять флагом или `VLLM_SKIP_P2P_CHECK`.
- **Симптом:** зависание или NaN в многокарточном режиме, исчезающие после отключения. **Причина:** проблема в кастомном ядре или в P2P-пути. **Действие:** оставить отключённым и зафиксировать конфигурацию.
- **Подтверждение принятого значения:** строка `Using ['CUSTOM', 'PYNCCL'] all-reduce backends (in dispatch order) for group 'tp' out of potential backends: [...]` — при отключении `'CUSTOM'` из списка пропадает. В стартовой строке конфига видно `disable_custom_all_reduce=True`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --tensor-parallel-size 4 --disable-custom-all-reduce --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --tensor-parallel-size 2 --no-disable-custom-all-reduce --device-ids "0,1"
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/device_communicators/custom_all_reduce.py`
- `vllm/vllm/distributed/device_communicators/cuda_communicator.py`
- `vllm/vllm/distributed/device_communicators/all_reduce_utils.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/platforms/rocm.py`
- `vllm/vllm/envs.py`
