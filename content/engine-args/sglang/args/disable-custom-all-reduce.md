---
schema: 1
engine: sglang
primaryName: "--disable-custom-all-reduce"
title: "--disable-custom-all-reduce"
summary: Выключает собственное ядро all-reduce SGLang и оставляет только NCCL/RCCL. Имеет смысл только при `--tp-size` больше единицы; обычный повод его задать — зависание или порча результата на конкретной связке модель + карта, а не тюнинг.
group: exec.comm
related:
  - --tp-size
  - --nnodes
  - --enable-p2p-check
  - --enable-mscclpp
  - --enable-torch-symm-mem
  - --enable-symm-mem
  - --enable-nccl-nvls
  - --enable-aiter-allreduce-fusion
  - --flashinfer-allreduce-fusion-backend
  - --enable-deterministic-inference
  - --device
---

# --disable-custom-all-reduce

## Кратко

При `--tp-size 1` этот флаг не делает ничего: all-reduce вообще не вызывается. Начиная с двух карт каждый слой модели заканчивается редукцией по TP-группе, и SGLang по умолчанию выполняет ее собственным CUDA/HIP-ядром поверх P2P-доступа между картами, а NCCL оставляет как запасной путь для больших тензоров. `--disable-custom-all-reduce` убирает это ядро полностью — все редукции идут через NCCL (RCCL на ROCm). Флаг нужен там, где custom-ядро ломается: дедлоки при EAGLE-верификации на AMD, порча результата на отдельных сборках, необходимость воспроизводимости. Как ускоритель он бесполезен — выключение custom AR не ускоряет ничего.

## Оригинальная справка

```text
Disable the custom all-reduce kernel and fall back to NCCL.
```

## Паспорт аргумента

- Флаги: `--disable-custom-all-reduce`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false` — custom all-reduce включен
- Эффективное значение: переписывается в трех местах. `--device npu` жестко ставит `True` (`hardware_backend/npu/utils.py`, комментарий «NPU does not support CustomAllReduce»). На ROCm для MiniMax-M3 (`MiniMaxM3SparseForCausalLM`/`…ForConditionalGeneration`) реестр переопределений ставит `True`, если не включен `--enable-aiter-allreduce-fusion` и не задан `SGLANG_M3_ALLOW_CUSTOM_AR=1`. `--enable-deterministic-inference` при `tp_size > 1` на CUDA тоже ставит `True` и одновременно печатает предупреждение про `NCCL_ALGO=allreduce:tree`
- Где объявлен: `ServerArgs.disable_custom_all_reduce`, файл — `sglang/python/sglang/srt/server_args.py`; поле помечено `resolvable=True`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (платформенные и модельные переопределения) → `init_torch_distributed` → `_set_all_reduce_flags` (`sglang/python/sglang/srt/distributed/bootstrap.py`) → конструктор `GroupCoordinator` для world- и TP-группы → каждый forward

## Что меняет в движке

`_set_all_reduce_flags` вызывает `set_custom_all_reduce(not disable_custom_all_reduce)`, что кладет значение в модульный флаг `_ENABLE_CUSTOM_ALL_REDUCE` (`distributed/parallel_state.py`). Флаг читается при создании каждой группы через `init_model_parallel_group`. Важно, что он влияет не на все группы: attention-TP-группа при `--enable-dp-attention` создается с явным `use_custom_allreduce=False`, поэтому DP-attention-конфигурации и без этого флага частично работают через NCCL.

Если custom AR разрешен, конструктор `GroupCoordinator` вызывает `dispatch_custom_allreduce`:

- **CUDA.** По умолчанию (`SGLANG_OPT_USE_CUSTOM_ALL_REDUCE_V2=1`) берется JIT-компилируемая `CustomAllReduceV2`. Она допускает world size 2–16 и требует **полного NVLink между всеми картами группы** (`can_use_custom_all_reduce_v2` → `can_use_custom_all_reduce_with_nvlink(...) is True`). Многоузловая группа отбрасывается, если не включен `SGLANG_ENABLE_CUSTOM_ALL_REDUCE_V2_MULTINODE` (тогда нужен один NVLink-клик, NVL72/MNNVL, и VMM-аллокатор).
- **CUDA, откат к легаси.** Если v2 не подходит, берется `CustomAllreduce`: world size только `2, 4, 6, 8`; при world size 2 достаточно рабочего P2P без NVLink, при 4 и больше NVLink между всеми картами обязателен.
- **ROCm.** `AiterCustomAllreduce` или сглэнговская `CustomAllreduce` (в зависимости от `SGLANG_USE_1STAGE_ALLREDUCE`), плюс отдельный `QuickAllReduce` для gfx942 и новее — он тоже создается только внутри ветки «custom AR включен», то есть этот флаг выключает и его.

Дальше на каждом forward `GroupCoordinator.all_reduce` выбирает путь заново, по размеру и типу тензора (`_resolve_outplace_all_reduce_method`). Приоритет: `ca` (custom) → `qr` (ROCm quick) → `pymscclpp` → `torch_symm_mem` → pynccl/`torch.distributed`. Custom-ядро берет тензор только если он проходит `should_custom_ar`: размер кратен 16 байтам и не превышает `max_size` (8 МиБ на CUDA у легаси-ядра, 16 МиБ на ROCm, у v2 — из `SGLANG_CUSTOM_ALL_REDUCE_V2_MAX_SIZE_KB`, по умолчанию тоже 16 МБ). Всё, что больше, и так уходит в NCCL — то есть на длинном prefill custom AR обычно не участвует, а на decode участвует почти всегда.

### Что заменяет в пути all-reduce

Редукции, о которых идет речь, — это выход `RowParallelLinear` (проекция `o_proj` внимания и выход MLP/MoE, `layers/linear.py`) и слитые пути в `layers/communicator.py`. Именно они на decode дают десятки мелких (сотни килобайт) редукций на токен, где latency ядра важнее пропускной способности. `--disable-custom-all-reduce` отдает их NCCL.

## Значения и формат

- Флаг без значения. Пары `--no-…` нет: чтобы вернуть custom AR, просто не передавайте флаг.
- Смысл появляется только при `tp_size * pp_size > 1`. На одной карте `GroupCoordinator.all_reduce` выходит по `world_size == 1` до любого выбора пути.
- Флаг ничего не «пробует и откатывает»: он именно запрещает создание объекта. Обратное — попытка создать custom AR при неподходящей топологии — заканчивается предупреждением и тем же NCCL.

## Когда использовать

- Сервер зависает на верификации спекулятивного декодирования на AMD. Апстрим-инструкция для GLM-5.1 прямо требует `--disable-custom-all-reduce` при EAGLE на MI300X/MI325X/MI355X: aiter-ядро custom all-reduce дедлочится при высокой конкурентности (`sglang/docs/cookbook/autoregressive/GLM/GLM-5.1.mdx`). То же самое в конфигурации MiMo-V2-Flash для MI355X.
- В логе на старте висит предупреждение `Setup Custom allreduce failed with …`: путь и так не используется, флаг просто убирает шум и лишнюю попытку выделить буферы.
- Подозрение на порчу чисел при TP: сравнить выход с NCCL-путем — самый быстрый способ локализовать проблему в ядре all-reduce.
- Не задавайте флаг «на всякий случай» на NVLink-хосте: на decode при `--tp-size 2..8` custom-ядро дает заметно меньшую latency, чем NCCL, и это единственное, за что оно отвечает.
- Не задавайте его как замену `--enable-deterministic-inference`: детерминизм требует еще и фиксации алгоритма и числа каналов NCCL, а это делает сам детерминированный режим.

## Влияние на производительность и память

- **VRAM.** Флаг освобождает буферы custom AR: у легаси-реализации это `max_size` (8 МиБ на CUDA, 16 МиБ на ROCm) на ранг плюс мета-буфер; у v2 — pull/push-workspace до `max_size` каждый. Единицы-десятки МиБ на карту, на размер KV-пула это практически не влияет.
- **Latency.** Основной эффект. На decode редукции мелкие, и разница между специализированным ядром и NCCL измеряется в микросекундах на слой, что на 60–90 слоях складывается в проценты TPOT. На prefill разницы почти нет: большие тензоры и так идут через NCCL.
- **Throughput.** На больших батчах — в пределах шума.
- **Время старта.** Немного уменьшается: не выполняется P2P-тест (он кешируется, но первый раз дорогой) и не компилируется JIT-вариант v2.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--tp-size`: без него флаг бессмыслен. Полный разбор того, откуда берутся редукции, — в справке `--tp-size`.
- `--enable-p2p-check`: по умолчанию SGLang патчит проверку P2P-доступа (`monkey_patch_p2p_access_check`); включенная проверка может отбраковать custom AR раньше, чем это сделает флаг.
- `--enable-mscclpp`, `--enable-torch-symm-mem`, `--enable-symm-mem`: альтернативные пути редукции в той же цепочке выбора. mscclpp имеет приоритет **над** custom AR, symm-mem-пути — после него.
- `--flashinfer-allreduce-fusion-backend` и `--enable-aiter-allreduce-fusion`: слияние all-reduce с Residual+RMSNorm вообще обходит эту цепочку для поддерживаемых слоев; на ROCm для MiniMax-M3 включенная aiter-фьюжен-ветка как раз и есть причина, по которой custom AR там не выключается принудительно.
- `--enable-deterministic-inference`: на CUDA при `tp_size > 1` сам ставит `disable_custom_all_reduce = True` и `enable_torch_symm_mem = False`, задавать флаг руками не нужно.
- `--device npu`: значение принудительно `True`, custom AR на Ascend не поддерживается.
- `--nnodes`: многоузловая группа отбрасывает custom AR с предупреждением `… is disabled because this process group spans across nodes.` вне MNNVL-опции.

## Типовые проблемы и диагностика

- **Симптом:** на старте `Setup Custom allreduce failed with <ошибка>. To silence this warning, specify --disable-custom-all-reduce explicitly.` **Причина:** не удалось выделить или зарегистрировать разделяемые буферы. **Следствие:** сервер работает, но на NCCL. **Решение:** задать флаг, чтобы убрать попытку.
- **Симптом:** `CustomAllReduceV2 is disabled because it's not supported on more than two PCIe-only GPUs.` **Причина:** карты соединены только через PCIe. **Решение:** ничего чинить не нужно, это корректный отказ; флаг лишь убирает предупреждение.
- **Симптом:** `… is disabled due to an unsupported world size: 3. Supported world sizes: [2, 4, 6, 8].` **Причина:** `--tp-size` вне списка. **Решение:** обычный NCCL-путь, либо сменить `--tp-size`.
- **Симптом:** сервер намертво встает на первых запросах при спекулятивном декодировании на AMD, watchdog в итоге убивает процесс. **Причина:** известный дедлок aiter-ядра custom AR при верификации. **Решение:** `--disable-custom-all-reduce`.
- **Что смотреть:** итоговый дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) покажет уже разрешенное значение — именно там видно, что NPU или детерминированный режим переписали ваш `false`. На ROCm при выключенном custom AR печатается `[AR] All-reduce call path: NCCL (custom AR disabled)`.
- **В arriero:** флаг меняется только правкой инстанса и рестартом; на живом процессе изменение отображается как `config drift` в health summary и применяется после перезапуска.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/GLM-5.1 --tensor-parallel-size 8 --disable-custom-all-reduce
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --disable-custom-all-reduce --enable-p2p-check
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce_v2.py`
- `sglang/python/sglang/srt/distributed/device_communicators/custom_all_reduce_utils.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/hardware_backend/npu/utils.py`
- `sglang/python/sglang/srt/layers/linear.py`
- `sglang/docs/cookbook/autoregressive/GLM/GLM-5.1.mdx`
- `sglang/docs/cookbook/autoregressive/Xiaomi/MiMo-V2-Flash.mdx`
