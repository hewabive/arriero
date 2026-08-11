---
schema: 1
engine: sglang
primaryName: "--enable-symm-mem"
title: "--enable-symm-mem"
summary: Переводит all-reduce TP-группы на симметричную память NCCL: буферы выделяются через `ncclMemAlloc`, регистрируются окнами и редуцируются multicast-ядрами NVLink. Требует NVSwitch/NVLS и резервирует 4 ГиБ VRAM на карту под пул.
group: exec.comm
related:
  - --enable-nccl-nvls
  - --enable-torch-symm-mem
  - --enable-mscclpp
  - --disable-custom-all-reduce
  - --tp-size
  - --dcp-size
  - --mem-fraction-static
  - --cuda-graph-backend-prefill
  - --enable-deterministic-inference
  - --speculative-algorithm
---

# --enable-symm-mem

## Кратко

`--enable-symm-mem` включает симметричную память NCCL для коллективов TP-группы. Практически это значит три вещи: NCCL запускается с `NCCL_CUMEM_ENABLE=1` и `NCCL_NVLS_ENABLE=1`, тензоры коммуникации выделяются в отдельном `torch.cuda.MemPool` поверх `ncclMemAlloc` и регистрируются через `ncclCommWindowRegister`, а сам all-reduce идет через pynccl **раньше** custom-ядра. Это путь для NVSwitch-хостов (H100/H200/B200 в составе HGX, GB200) — на карточной сборке без NVLS он либо не даст выигрыша, либо упадет на регистрации окна. Цена входа известна заранее: предвыделяется 4 ГиБ VRAM на карту, и это надо вычесть из бюджета до того, как считать `--mem-fraction-static`.

## Оригинальная справка

```text
Enable NCCL symmetric memory for fast collectives.
```

## Паспорт аргумента

- Флаги: `--enable-symm-mem`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: может быть сброшен в `False` для гибридных моделей Kimi (`KimiLinearForCausalLM`, `KimiK3ForConditionalGeneration`), если включен хотя бы один CUDA graph — `disable_kimi_k3_symm_mem` в `arg_groups/kimi_k3_hook.py` вызывается из `_handle_cuda_graph_config` и печатает предупреждение. Второй сброс — `_kimi_k3_overrides` при `--dcp-size > 1` («Kimi-K3 DCP disables --enable-symm-mem due to decode CUDA graph correctness issues»). В остальных случаях значение остается тем, что задали
- Где объявлен: `ServerArgs.enable_symm_mem`, файл — `sglang/python/sglang/srt/server_args.py`; поле помечено `resolvable=True`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config` → Kimi-хук; `_handle_gpu_memory_settings` → установка `SGLANG_SYMM_MEM_PREALLOC_GB_SIZE`) → `_set_envs_and_config` (переменные NCCL, `sglang/python/sglang/srt/entrypoints/engine.py`) → `initialize_model_parallel(enable_symm_mem=…)` → выделение весов и буферов внутри `use_symmetric_memory(...)` → предвыделение пула после захвата CUDA graph → каждый forward

## Что меняет в движке

### Переменные окружения NCCL

`_set_envs_and_config` пишет их до запуска процессов scheduler'а:

- `NCCL_CUMEM_ENABLE = int(enable_symm_mem)` — и заданное пользователем значение при включенном флаге **перезаписывается**, а не сохраняется;
- `NCCL_NVLS_ENABLE = int(enable_nccl_nvls or enable_symm_mem)` — то есть `--enable-symm-mem` автоматически включает NVLS, отдельно `--enable-nccl-nvls` для этого не нужен;
- `NCCL_GRAPH_MIXING_SUPPORT = 0` — только когда одновременно `--dcp-size > 1`.

### Аллокатор и регистрация окон

`SymmetricMemoryContext` (`distributed/device_communicators/pynccl_allocator.py`) на входе переключает аллокатор CUDA на общий `MemPool` поверх `ncclMemAlloc`, на выходе регистрирует все новые сегменты в текущем коммуникаторе через `ncclCommWindowRegister(..., NCCL_WIN_COLL_SYMMETRIC)`. Регистрация не «пробуется»: неудача возвращает ненулевой код и роняет процесс ассертом `nccl_allocator_register_segments_with_comm failed with return code: …`. То есть на хосте, где NCCL не умеет симметричные окна (старая версия, отсутствующий NVLS, запрещенный cuMem), сервер падает на старте, а не деградирует.

### Выбор пути all-reduce

В `GroupCoordinator.all_reduce` симметричная память проверяется **до** custom-ядра:

```python
if (self.pynccl_comm is not None
        and self.is_symmetric_memory_enabled()
        and not should_use_pymscclpp_allreduce
        and not _ca_takes_input):
    with self.pynccl_comm.change_state(enable=True):
        self.pynccl_comm.all_reduce(input_)
        return input_
```

`_ca_takes_input` истинно только при явном опте `SGLANG_ENABLE_CUSTOM_ALL_REDUCE_V2_MULTINODE`. Практический вывод: с `--enable-symm-mem` на одноузловой конфигурации pynccl забирает **все** редукции, а custom all-reduce и `--enable-torch-symm-mem` перестают участвовать, даже если включены. Исключение — mscclpp, он проверяется раньше.

Отдельно `--enable-symm-mem` влияет на attention-TP-группу: `initialize_model_parallel` создает ее с `use_pynccl=SYNC_TOKEN_IDS_ACROSS_TP or enable_symm_mem`, то есть иначе pynccl-коммуникатор в этой группе мог бы вообще не создаваться.

### Предвыделение пула

`_handle_gpu_memory_settings` при незаданном `SGLANG_SYMM_MEM_PREALLOC_GB_SIZE` ставит его в 4 и печатает предупреждение. После захвата CUDA graph `prealloc_symmetric_memory_pool` выделяет один блок такого размера в симметричном пуле (`model_runner_components/cuda_graph_setup.py`). Смысл — PyTorch-мемпулы не дефрагментируются, поэтому фрагментацию ограничивают одним большим куском заранее. Draft-воркер спекуляции предвыделение пропускает.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- На одной карте инертен: `use_symmetric_memory` выходит по `group_coordinator.world_size == 1`.
- Размер предвыделения меняется только переменной окружения `SGLANG_SYMM_MEM_PREALLOC_GB_SIZE` (целое число ГиБ); `0` или отрицательное значение отключает предвыделение, оставляя сам симметричный путь включенным.
- `SGLANG_DEBUG_SYMM_MEM=1` включает проверку того, что тензоры коллективов действительно лежат в симметричном пуле, с предупреждениями и стеком — это диагностика, а не режим работы.

## Когда использовать

- Хост с NVSwitch и рабочим NVLS (HGX H100/H200, B200, GB200 NVL), `--tp-size` 4 и больше, decode-нагрузка с заметной долей времени в коллективах. Апстрим прямо рекомендует флаг для Qwen3.5 на H100 FP8 (`sglang/docs/cookbook/autoregressive/Qwen/Qwen3.5.mdx`).
- Не включайте на хосте без NVSwitch: даже если регистрация окон пройдет, выигрыша от multicast не будет, а 4 ГиБ VRAM на карту вы уже потеряли.
- Не включайте вместе с гибридными моделями Kimi при работающих CUDA graph — движок все равно выключит флаг, и это правильно: адреса в симметричном пуле выделяются на каждый forward и не валидны для захваченного графа, из-за чего спекулятивное декодирование начинает молча выдавать мусор с accept, приколоченным к потолку.
- Не рассчитывайте, что флаг заменит `--enable-torch-symm-mem` или custom AR: он их вытесняет из пути, а не дополняет.

## Влияние на производительность и память

- **VRAM.** Минус 4 ГиБ на карту по умолчанию (предвыделенный пул) плюс сами буферы коллективов. При явно заданном `--mem-fraction-static` это прямой вычет из свободной памяти уже после расчета пула, то есть источник OOM на захвате графов. Проверяйте строку `Pre-allocating symmetric memory pool with 4 GiB` в логе.
- **Latency.** Ради этого флаг и существует: multicast-редукция по NVLink/NVSwitch на мелких decode-тензорах короче и NCCL-ring, и custom-ядра.
- **Throughput.** Выигрыш растет с `--tp-size`; при `--tp-size 2` он обычно в пределах шума.
- **CUDA graph.** Симметричная память входит в список несовместимостей `tc_piecewise`-графа prefill (`_disable_tc_piecewise_cudagraph_if_incompatible`, причина «symmetric memory») — prefill-граф будет отключен. Это заметная потеря на коротких запросах.
- **Время старта.** Плюс компиляция C-расширения аллокатора (кешируется в `tempdir/symm_allocator`), плюс предвыделение пула.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--enable-nccl-nvls`: включается автоматически вместе с этим флагом; отдельно задавать не нужно.
- `--enable-torch-symm-mem`: другой механизм (torch symmetric memory, не NCCL-окна). Одновременное включение бессмысленно — pynccl-ветка с NCCL symm mem срабатывает раньше и torch-путь просто не вызывается.
- `--enable-mscclpp`: проверяется **раньше** симметричной памяти, поэтому подходящие по размеру тензоры уйдут в mscclpp; кроме того, mscclpp сам смотрит на `enable_symm_mem`, чтобы разрешить алгоритм `default_allreduce_nvls_zero_copy`.
- `--disable-custom-all-reduce`: при включенной симметричной памяти custom AR и так не участвует на одноузловой конфигурации.
- `--dcp-size`: при значении больше 1 добавляется `NCCL_GRAPH_MIXING_SUPPORT=0`; для Kimi-K3 сочетание, наоборот, выключает симметричную память.
- `--cuda-graph-backend-prefill`: `tc_piecewise` будет отключен.
- `--mem-fraction-static`: 4 ГиБ предвыделения не учитываются автоподбором доли — при явно заданном значении уменьшайте его руками.
- `--enable-deterministic-inference`: он выключает `enable_torch_symm_mem` и custom AR, но `enable_symm_mem` не трогает; для воспроизводимости флаг лучше не включать.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: nccl_allocator_register_segments_with_comm failed with return code: …`, в stderr перед ним `ERROR: NCCL symmetric memory registration failed. '<текст NCCL>'`. **Причина:** NCCL не поддерживает симметричные окна на этом хосте/версии. **Решение:** убрать флаг.
- **Симптом:** OOM на захвате CUDA graph, которого не было без флага. **Причина:** 4 ГиБ предвыделения. **Решение:** уменьшить `--mem-fraction-static` или `SGLANG_SYMM_MEM_PREALLOC_GB_SIZE`.
- **Симптом:** предупреждение `Kimi hybrid model: ignoring --enable-symm-mem because CUDA graphs are on.` **Причина:** защита от порчи вывода; флаг проигнорирован. **Решение:** ничего не делать либо, если симметричная память действительно нужна, отключить захват на обеих фазах.
- **Симптом:** prefill стал медленнее после включения флага. **Причина:** отключен `tc_piecewise`-граф prefill. **Проверка:** сообщение о выключении prefill-графа в логе старта.
- **Что смотреть:** `Symmetric memory is enabled, setting symmetric memory prealloc size to 4GB as default.`, `Pre-allocating symmetric memory pool with 4 GiB`, итоговый дамп `server_args=`.
- **В arriero:** предвыделенные 4 ГиБ на карту входят в фактическое потребление процесса, но не выводятся аналитической оценкой памяти — при включенном флаге ориентируйтесь на measured-эвиденс (`docs/MEMORY_ESTIMATION.md`) и увеличивайте GPU-draw инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3.5-A3B-FP8 --tensor-parallel-size 8 --enable-symm-mem
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3.5-A3B-FP8 --tensor-parallel-size 8 --enable-symm-mem --mem-fraction-static 0.80
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/distributed/device_communicators/pynccl_allocator.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/arg_groups/kimi_k3_hook.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/docs/docs/references/environment_variables.mdx`
- `sglang/docs/cookbook/autoregressive/Qwen/Qwen3.5.mdx`
- `sglang/docs/cookbook/autoregressive/Moonshotai/Kimi-K3.mdx`
- arriero: `docs/MEMORY_ESTIMATION.md`
