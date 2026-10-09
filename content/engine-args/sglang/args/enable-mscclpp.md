---
schema: 1
engine: sglang
primaryName: "--enable-mscclpp"
title: "--enable-mscclpp"
summary: Подключает библиотеку MSCCL++ как путь AllReduce и AllGather для тех размеров сообщений, под которые на старте нашлась оттюнингованная конфигурация; остальное уходит на NCCL и другие пути. Требует установленного пакета `mscclpp`, world size группы 4, 8, 16, 32 или 64 и подряд идущих рангов; активен только внутри CUDA graph, поэтому с `--disable-cuda-graph` не дает ничего.
group: exec.comm
related:
  - --disable-custom-all-reduce
  - --enable-symm-mem
  - --enable-torch-symm-mem
  - --flashinfer-allreduce-fusion-backend
  - --tp-size
  - --disable-cuda-graph
  - --nnodes
  - --dtype
---

# --enable-mscclpp

## Кратко

MSCCL++ — отдельная библиотека коллективов от Microsoft с GPU-инициируемой коммуникацией; SGLang использует ее как альтернативу NCCL для AllReduce и AllGather. Флаг создает `PyMscclppCommunicator` у каждой model-parallel группы и на старте прогоняет автотюнинг: для каждого класса размеров сообщений от 512 Б до 8 МиБ подбирается алгоритм, число блоков и потоков; размеры без подобранной конфигурации уходят на NCCL и остальные пути. Три условия отсекают почти всё: пакет `mscclpp` должен быть установлен, world size группы обязан быть 4, 8, 16, 32 или 64, а ранги группы — идти подряд. Четвертое условие менее очевидно и важнее: коммуникатор переводится в активное состояние только на время захвата CUDA graph, поэтому в eager-режиме он не используется вообще.

## Оригинальная справка

```text
Enable MSCCL++ for tuned AllReduce and AllGather messages, with NCCL fallback.
```

## Паспорт аргумента

- Флаги: `--enable-mscclpp`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным — ни один обработчик пайплайна `__post_init__` (`arg_groups/`) его не переписывает. Но «включено» и «работает» здесь не одно и то же: отбраковка происходит уже в конструкторе коммуникатора и никак не отражается на `server_args`
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecComm.enable_mscclpp`
- Статус: обычный
- Этап применения: разбор CLI → `_set_all_reduce_flags` (`sglang/python/sglang/srt/distributed/bootstrap.py`, `set_mscclpp`) → конструктор `GroupCoordinator` (импорт `mscclpp`, создание `CommGroup`, сборка алгоритмов, автотюнинг) → захват CUDA graph → forward внутри графа

## Что меняет в движке

`set_mscclpp(enable_mscclpp)` кладет значение в `_ENABLE_MSCCLPP`; `init_model_parallel_group` передает его как `use_mscclpp`. Коммуникатор создается у каждой группы, построенной через `init_model_parallel_group` (TP, attention-TP, MoE-EP/MoE-TP, PP и другие), если ее `world_size > 1`; у world-группы — никогда. Группа, чей размер не входит в список, получает только предупреждение.

### Что проверяется при создании

`PyMscclppCommunicator.__init__` (`distributed/device_communicators/pymscclpp.py`):

- `import mscclpp` / `mscclpp.ext` / `mscclpp.default_algos` — при `ImportError` пишется предупреждение `PyMscclpp is unavailable because its dependencies failed to import: ...`, и коммуникатор остается недоступным. Пакет в pip-зависимости SGLang не входит; официальный Docker-образ собирает его из ветки `sglang-v0.10.1` репозитория `microsoft/mscclpp`;
- world size обязан быть в `(4, 8, 16, 32, 64)`, иначе предупреждение `PyMscclpp is disabled due to an unsupported world size: N. Supported world sizes: (4, 8, 16, 32, 64). ...`;
- ранги группы должны идти подряд (`ranks[-1] - ranks[0] == world_size - 1`), иначе предупреждение про unsupported group;
- дальше `CommGroup` сообщает, сколько рангов делят один IPC-домен (NVLink-домен, включая MNNVL). Если вся группа в одном домене, строятся «нативные» алгоритмы AllReduce (`default_allreduce_nvls_packet`, `default_allreduce_packet`, `default_allreduce_rsag_zero_copy`, а при включенном `--enable-symm-mem` еще и `default_allreduce_nvls_zero_copy`) — для world size 4–32; `nvls_*` требуют поддержки NVLS. Если доменов 2, 4 или 8, компилируются DSL-алгоритмы `allreduce_multi_nodes`, `allgather_multi_nodes` и `reducescatter_multi_nodes` (world size 4–64);
- автотюнинг гоняет кандидатов на реальных GPU для размеров 512 Б … 8 МиБ. В многодоменной конфигурации дополнительно сравнивается составной AllReduce «reduce-scatter + all-gather» (RSAG), и если он быстрее прямого, выбирается он. На ранге 0 каждый выбор печатается строкой `MSCCL++ <collective> tuning: message_bytes=... algorithm=... time_ms=...`, итог — `Created MSCCL++ communicator: group=<имя> world_size=... allreduce_configs=N allgather_configs=M`. Если тюнер не нашел ни одной конфигурации — `PyMscclpp did not produce any usable tuned configurations.`

Требования к топологии двухуровневые: внутри IPC-домена нужен NVLink/NVSwitch (алгоритмы `nvls_*` без multicast просто не попадут в кандидаты), между доменами — RDMA-транспорт, который MSCCL++ ожидает от InfiniBand/RoCE. Отдельный AllGather у одного IPC-домена не тюнингуется: нативных AllGather-алгоритмов нет, и там флаг ускоряет только AllReduce.

### Когда путь реально выбирается

Поле `disabled` у коммуникатора инициализируется значением `True` и переключается только контекстным менеджером `change_state(enable=True)`. Единственное место, где он используется, — `GroupCoordinator.graph_capture`. В комментарии там же есть таблица режимов: `PyMscclpp` — `disabled` в eager, `enabled` в graph. Причина названа прямо: mscclpp требует предварительной регистрации тензоров, и в eager-режиме накладные расходы это съедают.

Внутри графа:

- **AllReduce** (`should_mscclpp_allreduce`): тип `float32`/`float16`/`bfloat16`, слабо-непрерывный тензор, операция `SUM`, оттюнингованная конфигурация под этот класс размера (размер округляется вверх до степени двойки; сообщение меньше 512 Б берет конфигурацию 512 Б, крупнее 8 МиБ — уходит дальше) и **отсутствие** piecewise-CUDA-graph фазы (`is_in_tc_piecewise_cuda_graph()`, `is_in_torch_compile_warmup()`, активный `pcg_capture_stream`) — там смена пути редукции вызывала бы перекомпиляцию. Если условия выполнены, mscclpp стоит **выше** custom all-reduce и PCIe-IPC: их ветки явно требуют `not should_use_pymscclpp_allreduce`, и симметричная память NCCL — тоже. Впереди mscclpp остаются только FlashInfer allreduce (если включен `--flashinfer-allreduce-fusion-backend`) и, на ROCm, quick allreduce.
- **AllGather** (`should_mscclpp_allgather`): совпадающие dtype, непрерывные входной и выходной тензоры на одном устройстве, вход кратен 16 байтам, оттюнингованная конфигурация под размер выхода, та же piecewise-оговорка. Путь стоит после aiter custom all-gather на ROCm и перед pynccl.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Работает только у групп размером 4, 8, 16, 32 или 64. `--tp-size 2` с этим флагом — тихий no-op плюс warning.
- Нижняя и верхняя границы размера сообщения задаются таблицей тюнера: меньше 512 Б используется конфигурация 512 Б, больше 8 МиБ — mscclpp не участвует; если для класса нет конфигурации, тензор уходит следующему пути.

## Когда использовать

- Узел с NVSwitch (4 или 8 карт), MNNVL-стойка либо 2–8 узлов с RDMA, установленный `mscclpp`, CUDA graph включены, и профилирование показывает, что decode упирается в AllReduce/AllGather. Только тогда флаг имеет смысл.
- Не включайте вместе с `--disable-cuda-graph` или конфигурацией, где decode-граф отключен: коммуникатор будет построен и оттюнингован (это время старта), но ни разу не вызван.
- Не включайте, если ни одна значимая группа (обычно TP) не имеет размера 4/8/16/32/64.
- Не считайте флаг заменой custom all-reduce: он его вытесняет только на тех размерах, для которых тюнер нашел конфигурацию.

## Влияние на производительность и память

- **Время старта.** Главная плата. Сборка алгоритмов (для многодоменных конфигураций — компиляция DSL-программ на каждую комбинацию потоков и `thread_block_group_size`) и `_tune` реально гоняют кандидатов на GPU: 5 прогревов и 20 запусков графа по 20 операций на каждую комбинацию блоков и потоков, по 15 классам размеров, для каждой коллективной операции и для каждой подходящей группы. Это добавляет секунды-десятки секунд к запуску, особенно в многоузловых конфигурациях.
- **VRAM.** Скретч-буфер 128 МиБ (`RawGpuBuffer(1 << 27)`) для нативных алгоритмов плюс внутренние структуры MSCCL++ на каждый ранг и каждую группу с коммуникатором; на время тюнинга — временные буферы до 8 МиБ.
- **Latency.** Ради нее флаг и нужен: на мелких сообщениях packet-алгоритмы MSCCL++ обычно быстрее NCCL и custom-ядра.
- **Throughput.** На крупных сообщениях выигрыш меньше — там работает `rsag_zero_copy` или RSAG-композиция, и разница с NCCL невелика.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--tp-size` (и другие размеры параллелизма): определяют world size групп и, следовательно, саму возможность работы пути.
- `--disable-cuda-graph`, `--cuda-graph-backend-prefill disabled`: без захвата графа путь не активируется; в piecewise-фазах он явно запрещен.
- `--enable-symm-mem`: разблокирует алгоритм `default_allreduce_nvls_zero_copy` в наборе mscclpp (коммуникатор читает `enable_symm_mem` при построении алгоритмов), но при этом сам симметричный путь pynccl стоит в `all_reduce` после проверки mscclpp — то есть подходящие тензоры все равно достанутся mscclpp.
- `--flashinfer-allreduce-fusion-backend`: FlashInfer allreduce проверяется раньше mscclpp, и тензоры, которые он берет, до mscclpp не доходят.
- `--disable-custom-all-reduce`: не требуется, mscclpp и так имеет приоритет над custom-ядром на «своих» размерах.
- `--enable-torch-symm-mem`: проверяется после mscclpp.
- `--nnodes`: многоузловые конфигурации (2, 4 или 8 IPC-доменов) получают DSL-алгоритмы; на одном узле нужны нативные.
- `--dtype`: путь работает с fp32/fp16/bf16.

## Типовые проблемы и диагностика

- **Симптом:** `PyMscclpp is unavailable because its dependencies failed to import: ...`. **Причина:** пакет `mscclpp` (или его `ext`/`default_algos`) не установлен. **Проверка:** `python -c "import mscclpp, mscclpp.ext, mscclpp.default_algos"` в том же окружении.
- **Симптом:** `PyMscclpp is disabled due to an unsupported world size: 2.` **Причина:** размер группы вне списка. Для TP — убрать флаг; для вспомогательных групп (например, PP) предупреждение ожидаемо и безвредно.
- **Симптом:** `PyMscclpp is disabled due to an unsupported group [...]. Please ensure all ranks in the group are consecutive.` **Причина:** нарезка рангов (например, разреженная через `--gpu-id-step` в сочетании с DP) дала непоследовательную группу.
- **Симптом:** старт падает с `Failed to initialize MSCCL++ collectives` и `RuntimeError: The installed MSCCL++ package does not provide default_algos.<name>`. **Причина:** установленная версия MSCCL++ старее той, под которую написан SGLang (многоузловые DSL-алгоритмы). В отличие от отбраковок выше, любая ошибка сборки алгоритмов или тюнинга не отключает путь, а пробрасывается и роняет процесс. **Решение:** версия из `docker/Dockerfile` checkout'а (`MSCCLPP_VERSION`) либо убрать флаг.
- **Симптом:** старт стал длиннее на десятки секунд. **Причина:** автотюнинг. **Решение:** ожидаемо; если это неприемлемо, флаг не для вашей нагрузки.
- **Что смотреть:** итоговый дамп `server_args=` покажет, что флаг принят, но не покажет, что путь работает. Подтверждение — строка `Created MSCCL++ communicator: ... allreduce_configs=N allgather_configs=M` для нужной группы с ненулевыми счетчиками плюс измеренная разница latency.
- **В arriero:** в SGLang-KT-профиле это редкий флаг — `mscclpp` не входит в закрепленную пару `sglang-kt` + `kt-kernel`, поэтому перед использованием проверьте наличие пакета в окружении инстанса (`docs/ENVIRONMENTS.md`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enable-mscclpp
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enable-mscclpp --enable-symm-mem
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/distributed/device_communicators/pymscclpp.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/docker/Dockerfile`
- upstream PR #37442 «Add 8-node AllReduce/AllGather and MNVLS algorithm support to MSCCL++» (коммит `e047e50d4e` в checkout)
- arriero: `docs/ENVIRONMENTS.md`
