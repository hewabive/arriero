---
schema: 1
engine: sglang
primaryName: "--enable-mscclpp"
title: "--enable-mscclpp"
summary: Подключает библиотеку MSCCL++ как путь all-reduce для мелких сообщений. Требует установленного пакета `mscclpp`, world size ровно 8, 16 или 32 и подряд идущих рангов; активен только внутри CUDA graph, поэтому с `--disable-cuda-graph` не дает ничего.
group: exec.comm
related:
  - --disable-custom-all-reduce
  - --enable-symm-mem
  - --enable-torch-symm-mem
  - --tp-size
  - --disable-cuda-graph
  - --disable-piecewise-cuda-graph
  - --nnodes
  - --dtype
---

# --enable-mscclpp

## Кратко

MSCCL++ — отдельная библиотека коллективов от Microsoft с GPU-инициируемой коммуникацией; SGLang использует ее как альтернативу NCCL на мелких all-reduce. Флаг создает `PyMscclppCommunicator` у TP-группы и на старте прогоняет автотюнинг: для каждого класса размеров сообщений подбирается алгоритм, число блоков и потоков. Три условия отсекают почти всё: пакет `mscclpp` должен быть установлен, world size обязан быть ровно 8, 16 или 32, а ранги группы — идти подряд. Четвертое условие менее очевидно и важнее: коммуникатор переводится в активное состояние только на время захвата CUDA graph, поэтому в eager-режиме он не используется вообще.

## Оригинальная справка

```text
Enable using mscclpp for small messages for all-reduce kernel and fall back to NCCL.
```

## Паспорт аргумента

- Флаги: `--enable-mscclpp`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным — ни один `_handle_*` и ни одно правило `arg_groups/overrides.py` его не переписывает. Но «включено» и «работает» здесь не одно и то же: отбраковка происходит уже в конструкторе коммуникатора и никак не отражается на `server_args`
- Где объявлен: `ServerArgs.enable_mscclpp`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_set_all_reduce_flags` (`sglang/python/sglang/srt/distributed/bootstrap.py`) → конструктор `GroupCoordinator` (импорт `mscclpp`, создание `CommGroup`, автотюнинг) → захват CUDA graph → forward внутри графа

## Что меняет в движке

`set_mscclpp_all_reduce(server_args.enable_mscclpp)` кладет значение в `_ENABLE_MSCCLPP_ALL_REDUCE`; `init_model_parallel_group` передает его как `use_pymscclpp`. Коммуникатор создается только у групп, которым этот флаг передан (world- и TP-группа), и только при `world_size > 1`.

### Что проверяется при создании

`PyMscclppCommunicator.__init__` (`distributed/device_communicators/pymscclpp.py`):

- `import mscclpp` / `mscclpp.ext` / `mscclpp.default_algos` — при `ImportError` объект остается недоступным без единого сообщения в логе. Это самый частый молчаливый отказ: пакет в стандартную поставку SGLang не входит;
- world size обязан быть в `[8, 16, 32]`, иначе предупреждение `PyMscclpp is disabled due to an unsupported world size: N. Supported world sizes: [8, 16, 32].`;
- ранги группы должны идти подряд (`ranks[-1] - ranks[0] == world_size - 1`), иначе предупреждение про unsupported group;
- при world size 8 строятся «нативные» алгоритмы (`default_allreduce_nvls_packet`, `default_allreduce_packet`, `default_allreduce_rsag_zero_copy`, а при включенном `--enable-symm-mem` еще и `default_allreduce_nvls_zero_copy`), при 16 и 32 — DSL-алгоритмы для 2- и 4-узловых конфигураций. Дальше идет автотюнинг с реальными запусками на GPU.

Требования к топологии здесь двухуровневые: внутри узла нужен NVLink/NVSwitch (алгоритмы `nvls_*` без multicast просто не будут выбраны тюнером), между узлами — RDMA-транспорт, который MSCCL++ ожидает от InfiniBand/RoCE. Именно поэтому 16 и 32 — это про 2 и 4 узла по 8 карт, а не про произвольную нарезку.

### Когда путь реально выбирается

Поле `disabled` у коммуникатора инициализируется значением `True` и переключается только контекстным менеджером `change_state(enable=True)`. Единственное место, где он используется, — `GroupCoordinator.graph_capture`. В комментарии там же есть таблица режимов: `PyMscclpp` — `disabled` в eager, `enabled` в graph. Причина названа прямо: mscclpp требует предварительной регистрации тензоров, и в eager-режиме накладные расходы это съедают.

Внутри графа `should_mscclpp_allreduce` дополнительно требует: тип `float32`/`float16`/`bfloat16`, слабо-непрерывный тензор, операция `SUM`, наличие подобранной конфигурации под этот класс размера (тюнер покрывает диапазон от 512 Б до 256 МиБ) и **отсутствие** piecewise-CUDA-graph фазы (`is_in_tc_piecewise_cuda_graph()`, `is_in_torch_compile_warmup()`, активный `pcg_capture_stream`) — там смена пути редукции вызывала бы перекомпиляцию.

Если условия выполнены, mscclpp стоит **выше** custom all-reduce: в `all_reduce` ветка `ca` явно требует `not should_use_pymscclpp_allreduce`, и симметричная память NCCL — тоже.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Работает только при world size 8, 16 или 32. `--tp-size 4` с этим флагом — тихий no-op плюс warning.
- Нижняя и верхняя границы размера сообщения задаются таблицей тюнера: меньше 512 Б округляется вверх до 512 Б, больше 256 МиБ — до 256 МиБ; если для класса нет конфигурации, тензор уходит следующему пути.

## Когда использовать

- Узел из 8 карт с NVSwitch либо 2–4 таких узла с RDMA, установленный `mscclpp`, CUDA graph включены, и профилирование показывает, что decode упирается в all-reduce. Только тогда флаг имеет смысл.
- Не включайте вместе с `--disable-cuda-graph` или конфигурацией, где decode-граф отключен: коммуникатор будет построен и оттюнингован (это время старта), но ни разу не вызван.
- Не включайте при `--tp-size`, не равном 8/16/32.
- Не считайте флаг заменой custom all-reduce: он его вытесняет только на тех размерах, для которых тюнер нашел конфигурацию.

## Влияние на производительность и память

- **Время старта.** Главная плата. `_create_algorithms` + `_tune` реально гоняют кандидатов на GPU (несколько прогревов, десятки запусков графа на каждую комбинацию блоков и потоков, по нескольким классам размеров). Это добавляет секунды-десятки секунд к запуску, особенно на world size 16/32 с DSL-алгоритмами.
- **VRAM.** Скретч-буфер 128 МиБ (`RawGpuBuffer(1 << 27)`) плюс флаг-буфер и внутренние структуры MSCCL++ на каждый ранг.
- **Latency.** Ради нее флаг и нужен: на мелких сообщениях packet-алгоритмы MSCCL++ обычно быстрее NCCL и custom-ядра.
- **Throughput.** На крупных сообщениях выигрыш меньше — там работает `rsag_zero_copy`, и разница с NCCL невелика.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--tp-size`: определяет world size и, следовательно, саму возможность работы пути.
- `--disable-cuda-graph`, `--disable-piecewise-cuda-graph`: без захвата графа путь не активируется; в piecewise-фазах он явно запрещен.
- `--enable-symm-mem`: разблокирует алгоритм `default_allreduce_nvls_zero_copy` в наборе mscclpp (коммуникатор читает `enable_symm_mem` при построении алгоритмов), но при этом сам симметричный путь pynccl стоит в `all_reduce` после проверки mscclpp — то есть подходящие тензоры все равно достанутся mscclpp.
- `--disable-custom-all-reduce`: не требуется, mscclpp и так имеет приоритет над custom-ядром на «своих» размерах.
- `--enable-torch-symm-mem`: проверяется после mscclpp.
- `--nnodes`: 16 и 32 предполагают 2 и 4 узла; на одном узле с 8 картами используйте world size 8.
- `--dtype`: путь работает с fp32/fp16/bf16.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, в логе ни строки про mscclpp, ускорения нет. **Причина:** пакет `mscclpp` не установлен — `ImportError` перехватывается без сообщения. **Проверка:** `python -c "import mscclpp"` в том же окружении.
- **Симптом:** `PyMscclpp is disabled due to an unsupported world size: 4.` **Причина:** `--tp-size` вне списка. **Решение:** убрать флаг.
- **Симптом:** `PyMscclpp is disabled due to an unsupported group [...]. Please ensure all ranks in the group are consecutive.` **Причина:** нарезка рангов (например, разреженная через `--gpu-id-step` в сочетании с DP) дала непоследовательную группу.
- **Симптом:** старт стал длиннее на десятки секунд. **Причина:** автотюнинг. **Решение:** ожидаемо; если это неприемлемо, флаг не для вашей нагрузки.
- **Что смотреть:** итоговый дамп `server_args=` покажет, что флаг принят, но не покажет, что путь работает — единственный надежный сигнал отсутствия отказа — это отсутствие перечисленных предупреждений плюс измеренная разница latency.
- **В arriero:** в SGLang-KT-профиле это редкий флаг — `mscclpp` не входит в закрепленную пару `sglang-kt` + `kt-kernel`, поэтому перед использованием проверьте наличие пакета в окружении инстанса (`docs/ENVIRONMENTS.md`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enable-mscclpp
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --enable-mscclpp --enable-symm-mem
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/device_communicators/pymscclpp.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/ENVIRONMENTS.md`
