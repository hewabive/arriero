---
schema: 1
engine: sglang
primaryName: "--tp-size"
title: "--tp-size"
summary: Число GPU, между которыми режутся веса модели и KV-пул одного экземпляра. Задается на каждом узле одинаково и определяет размер world group; менять его после старта нельзя.
group: parallel
related:
  - --pp-size
  - --dp-size
  - --ep-size
  - --moe-dp-size
  - --moe-dense-tp-size
  - --enable-dp-attention
  - --attn-cp-size
  - --dcp-size
  - --mem-fraction-static
  - --nnodes
  - --base-gpu-id
  - --gpu-id-step
  - --enable-quant-communications
  - --disable-custom-all-reduce
---

# --tp-size

## Кратко

`--tp-size` — единственный аргумент, который обязана задать любая мультикарточная конфигурация. Он объявляет размер тензорно-параллельной группы: сколько scheduler-процессов будет запущено, сколько GPU займет один экземпляр и на сколько частей будет порезана каждая матрица весов. Значение по умолчанию `1` никогда не переопределяется движком — что задали, то и работает. Ошибки в нем видны сразу: либо `AssertionError: <N> is not divisible by <tp>` на загрузке весов, либо тихая потеря памяти, когда KV-кеш модели с одной KV-головой размножается по всем картам вместо того, чтобы делиться.

## Оригинальная справка

```text
The tensor parallelism size.
```

## Паспорт аргумента

- Флаги: `--tp-size`, `--tensor-parallel-size`. Форма `--tp`, которую используют примеры апстрима, — не объявленный алиас, а сокращение argparse: `--tp` остается однозначным префиксом только потому, что других флагов на `--tp` нет. Появление такого флага в будущем сломает строки запуска, поэтому в конфигурации пишите полное имя
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; практический предел — число видимых GPU на узел, умноженное на `--nnodes`
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным. Ни один `_handle_*` и ни одно правило из `arg_groups/overrides.py` не переписывает `tp_size` — это редкий для SGLang случай, когда декларативный default и есть эффективное значение. Обратное неверно: `tp_size` сам служит источником для `--ep-size` (при a2a-backend), `--dcp-size`, `--attn-cp-size` и для резерва в `--mem-fraction-static`
- Где объявлен: `ServerArgs.tp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `check_server_args` (делимость на `--nnodes`) → запуск `tp_size` scheduler-процессов → `init_torch_distributed` (создание world/TP/PP-групп) → загрузка и шардирование весов → выделение KV-пула → захват CUDA graph

## Что меняет в движке

### Процессы и ранги

`tp_size * pp_size` — это world size у `torch.distributed`; ранг вычисляется как `tp_size * pp_rank + tp_rank` (`distributed/bootstrap.py:_init_parallel_groups`). На одном узле поднимается `tp_size` процессов-scheduler'ов, каждому назначается GPU

```python
gpu_id = base_gpu_id + (pp_rank % pp_size_per_node) * tp_size_per_node
                     + (tp_rank % tp_size_per_node) * gpu_id_step
```

то есть при `--tp-size 4` занимаются устройства `0,1,2,3` из числа видимых (`CUDA_VISIBLE_DEVICES` применяется раньше). При `tp_size > 1` в префикс каждой строки лога и в имя процесса добавляется ` TP<rank>`: `[2026-08-11 12:00:00 TP2] ...`, `sglang::scheduler_TP2`.

### Шардирование весов

Каждый линейный слой режется через `divide()` (`distributed/utils.py`), который сначала проверяет делимость:

- `QKVParallelLinear`: `num_heads = divide(total_num_heads, tp_size)` — число attention-голов **обязано** делиться на `tp_size`;
- MoE-слой: `assert intermediate_size % moe_tp_size == 0`, где `moe_tp_size = tp_size // ep_size // moe_dp_size`;
- `RowParallelLinear`/`ColumnParallelLinear`: `input_size`/`output_size` делятся на `tp_size`.

KV-головы — отдельный случай и главный источник недоразумений:

```python
if kv_tp_size >= self.total_num_kv_heads:
    self.num_kv_heads = 1
    self.num_kv_head_replicas = divide(kv_tp_size, self.total_num_kv_heads)
else:
    self.num_kv_heads = divide(self.total_num_kv_heads, kv_tp_size)
```

Когда рангов больше, чем KV-голов (предельный случай — MLA-модели DeepSeek/Kimi/MiniMax с одной KV-головой), KV **не делится, а реплицируется**: каждый ранг держит полную копию. Умножение `--tp-size` в этой ситуации увеличивает суммарный расход VRAM под KV-кеш в `tp_size` раз и не дает ни одного лишнего токена конкурентности. Ровно для этого случая существует `--enable-dp-attention`.

### Размер KV-пула

Пул считается по числу KV-голов на ранг: `model_config.get_num_kv_heads(get_parallel().attn_tp_size, attn_dcp_size)` (`mem_cache/kv_cache_configurator.py`). Без DP-attention и без CP `attn_tp_size == tp_size`, поэтому для GQA-модели с `num_key_value_heads = 8` переход с `--tp-size 1` на `--tp-size 2` вдвое уменьшает `cell_size` и примерно вдвое увеличивает `max_total_num_tokens` при том же `--mem-fraction-static`.

## Значения и формат

- Целое ≥ 1. `0` и отрицательные argparse примет, но world size окажется невалидным и `torch.distributed` упадет при инициализации группы.
- Особых значений нет: `1` — это «без тензорного параллелизма», а не «авто».
- `tp_size * pp_size` должно делиться на `--nnodes` (`check_server_args`, сообщение `tp_size must be divisible by number of nodes`), иначе `tp_size_per_node` посчитается неверно.
- Значение обязано совпадать на всех узлах многоузлового запуска: это глобальный, а не локальный размер.
- Кратность двойке не требуется формально, но `--tp-size 3` или `6` почти всегда упирается в делимость числа голов.

## Когда использовать

- Модель не помещается в одну карту — единственный обязательный сценарий. Начинайте с минимального `tp_size`, при котором веса плюс разумный KV-пул влезают: каждый лишний ранг добавляет all-reduce на каждый слой.
- GQA/MHA-модель, `num_key_value_heads ≥ tp_size`: рост `--tp-size` реально увеличивает KV-пул, это рабочий способ поднять конкурентность.
- MLA-модель (одна KV-голова) на 4+ картах: `--tp-size` без `--enable-dp-attention` — почти всегда ошибка. Веса поделятся, KV-кеш размножится.
- Не поднимайте `--tp-size` ради «ускорения» на модели, которая уже помещается в одну карту: на decode коммуникация съест выигрыш, а `--dp-size` (несколько реплик) даст больше throughput на тех же картах.
- Не меняйте значение «на живую» без пересчета `--mem-fraction-static`, если оно задано явно: резерв под активации зависит от `tp_size`.

## Влияние на производительность и память

- **VRAM.** Веса делятся на `tp_size` практически линейно. KV-пул делится только в той мере, в какой делятся KV-головы (см. выше). Коммуникационные буферы NCCL и custom all-reduce растут с размером группы.
- **Резерв под активации.** `--mem-fraction-static` в автоподборе добавляет `tp_size * pp_size / 8 * 1024` МиБ резерва, так что рост `tp_size` при незаданном `--mem-fraction-static` немного уменьшает KV-пул на каждой карте. Механика подбора — в `mem-fraction-static.md`, здесь она не повторяется.
- **Latency.** Каждый слой добавляет all-reduce по группе. На NVLink это дешево, на PCIe при `tp_size > 2` decode-latency растет заметно; `--disable-custom-all-reduce` и `--enable-p2p-check` управляют выбором пути.
- **Время старта.** Растет: `tp_size` процессов параллельно читают веса, инициализируют NCCL и захватывают CUDA graph каждый на своей карте.
- **Throughput.** Выигрыш нелинейный. Для MoE-моделей сочетание с `--ep-size` и `--moe-a2a-backend` определяет масштабирование сильнее, чем сам `tp_size`.
- **Хост.** `tp_size` полноценных python-процессов: RAM хоста и число потоков растут пропорционально.

## Взаимодействие с другими аргументами

- `--pp-size`: `world_size = tp_size * pp_size`, произведение обязано делиться на `--nnodes`.
- `--dp-size` без `--enable-dp-attention`: реплик `dp_size`, каждая со своей TP-группой, суммарно `dp_size * tp_size * pp_size` GPU.
- `--enable-dp-attention`: разбивает ту же TP-группу — `attn_tp_size = tp_size // dp_size // attn_cp_size`; требует `tp_size % dp_size == 0`.
- `--ep-size`: `moe_tp_size = tp_size // ep_size // moe_dp_size`; любой `--moe-a2a-backend`, кроме `none`, принудительно приравнивает `ep_size` к `tp_size` (см. `moe-a2a-backend.md`).
- `--moe-dense-tp-size`: принимает только `None`, `1` или ровно `tp_size` — иное значение отвергается в `check_server_args`.
- `--attn-cp-size` / `--dcp-size`: делят ту же группу; `tp_size % attn_cp_size == 0` и `tp_size % (dp_size * attn_cp_size) == 0`.
- `--mem-fraction-static`: `tp_size` входит в формулу резерва; при явно заданной доле связь пропадает.
- `--base-gpu-id` / `--gpu-id-step`: сдвигают и разрежают набор занимаемых устройств; полезно, когда на хосте живет несколько экземпляров.
- `--enable-quant-communications`: при `tp_size == 1` запускает `ValueError: Communications quantization is only used with tp_size != 1`.
- `--enable-deterministic-inference` при `tp_size > 1` на CUDA принудительно ставит `NCCL_ALGO=allreduce:tree`, фиксирует число каналов NCCL и выключает custom/symmetric-memory all-reduce.

## Типовые проблемы и диагностика

- `AssertionError: 32 is not divisible by 6` при загрузке весов — число голов (или `intermediate_size`) не делится на `tp_size`. Сообщение приходит из `ensure_divisibility`; исправляется только выбором делителя.
- `AssertionError: tp_size must be divisible by number of nodes` — нарушено `(tp_size * pp_size) % nnodes == 0`.
- Старт зависает на `Init torch distributed begin.` — узлы не собрались в group: проверьте `--dist-init-addr`, `--nnodes`, `--node-rank`, доступность порта и `--dist-timeout`. Апстрим-документация советует при дедлоках дополнительно попробовать `--disable-cuda-graph`.
- `The memory capacity is unbalanced. Some GPUs may be occupied by other processes.` (`_check_tp_memory_balance`) — на одной из карт группы уже кто-то есть; пул будет посчитан по худшей карте. С `SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK=1` это станет `RuntimeError` вместо предупреждения.
- `max_total_num_tokens` почти не вырос после удвоения `--tp-size` — модель имеет меньше KV-голов, чем рангов, и KV реплицируется. Смотрите `KV Cache is allocated. … K size: … GB` до и после.
- Итоговое значение — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`), фактические ранги — в префиксах ` TP<n>` строк лога.
- **В arriero:** preflight инстанса KTransformers читает только ключи `--tensor-parallel-size` и `--tp` (`apps/api/src/process/preflight-ktransformers.ts`). Если в аргументах написано `--tp-size`, preflight будет считать TP равным 1: проверка «TP не больше числа видимых GPU» не сработает, а список выбранных GPU-пулов схлопнется до первого устройства, из-за чего резервация на второй карте будет отвергнута как `GPU reservation … is outside CUDA visibility and tensor-parallel order`. Для инстансов arriero задавайте `--tensor-parallel-size`.
- **KTransformers-профиль:** обертка CPU-экспертов создается и вызывается только на `tp_rank == 0` (`layers/moe/kt_ep_wrapper.py`), а ее результат втягивается в общий all-reduce MoE-слоя. Практически это значит, что рост `--tp-size` не распараллеливает CPU-часть: один пул `--kt-cpuinfer` обслуживает всю модель независимо от TP.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --ep-size 8 --moe-a2a-backend deepep
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/distributed/utils.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/layers/linear.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- `sglang/docs/docs/advanced_features/dp_dpa_smg_guide.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
