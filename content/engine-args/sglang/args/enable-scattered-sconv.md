---
schema: 1
engine: sglang
primaryName: "--enable-scattered-sconv"
title: "--enable-scattered-sconv"
summary: Аргумент одной архитектуры (Inkling): меняет all-reduce на выходе внимания и MLP на reduce-scatter по скрытой размерности, чтобы канальная короткая свертка и ее кеш состояний тоже шардировались по TP-рангам. Объем коммуникации не меняется, экономится память под conv-кеш.
group: exec.comm
related:
  - --tp-size
  - --enable-torch-symm-mem
  - --enable-dp-attention
  - --disable-custom-all-reduce
  - --max-running-requests
---

# --enable-scattered-sconv

## Кратко

У моделей Inkling после проекции выхода внимания и после MLP/MoE стоит канальная короткая свертка (`ShortConvolution`, «sconv») с собственным кешем состояний на каждую последовательность. По умолчанию слой делает полный all-reduce до `[T, H]`, считает свертку на полной ширине и добавляет residual — значит кеш свертки размером `(kernel_size − 1) × hidden_size` дублируется на каждом TP-ранге. Флаг переставляет операции: reduce-scatter до `[T, H/P]`, свертка на шарде, all-gather обратно перед сложением с residual. Суммарный объем передачи тот же (reduce-scatter + all-gather ≈ all-reduce), но веса свертки и ее кеш состояний делятся на `tp_size`. За пределами Inkling флаг не читается ни одним слоем.

## Оригинальная справка

```text
Inkling: replace the attention/MLP output all-reduce with a hidden-dimension reduce-scatter, run the channelwise output short convolution on the [T, H/P] shard, then all-gather before the residual add. This shards the convolution cache across tensor-parallel ranks without changing communication volume.
```

## Паспорт аргумента

- Флаги: `--enable-scattered-sconv`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным — ни `__post_init__`, ни реестр `arg_groups/overrides.py` его не переписывают. Но у флага есть жесткие требования, проверяемые при построении слоя, а не при разборе аргументов (см. ниже)
- Где объявлен: `ServerArgs.enable_scattered_sconv`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но узкоархитектурный: значение читают только `configs/inkling.py`, `models/inkling.py`, `models/inkling_common/{attn,moe,dense_mlp}.py`, `models/inkling_common/kernels/comm.py` и `distributed/device_communicators/torch_symm_mem.py`
- Этап применения: разбор CLI → построение слоев модели (ассерты делимости, размер conv-кеша) → выделение кеша состояний свертки → каждый forward

## Что меняет в движке

### Форма данных и коммуникация

- `models/inkling_common/attn.py`: `wo_ud` (`RowParallelLinear`) и так создается с `reduce_results=False`; при включенном флаге редукция выхода становится reduce-scatter по скрытой размерности.
- `models/inkling_common/dense_mlp.py` и `moe.py`: вместо `symm_mem_all_reduce(x, tp_group)` вызывается `reduce_scatter_hidden(x, tp_group)`.
- `models/inkling.py`: `attn_sconv` и `mlp_sconv` создаются с шириной `hidden_size // attn_tp_group.world_size`, а после свертки слой делает all-gather обратно до `[T, H]` перед сложением с residual. Там же два ассерта: `--enable-scattered-sconv requires use_sconv` и `config.hidden_size % attn_tp_group.world_size == 0`.
- `configs/inkling.py`: `stream_dim` в описании кеша состояний становится `hidden_size // tp_size` (с ассертом делимости), то есть шардируются именно те две строки conv-кеша, что отвечают за выходные свертки.

### Транспорт

`reduce_scatter_hidden` и `all_gather_hidden` (`models/inkling_common/kernels/comm.py`) сначала пробуют мультикаст-путь через `group.torch_symm_mem_comm` (`_symm_mem_comm`): нужен непустой коммуникатор, совпадение dtype, поддерживаемый world size и размер полного `[T, H]` в пределах его буфера. Если условия не выполнены — обычный `reduce_scatter_tensor` / `all_gather` через NCCL, с одной дополнительной транспозицией на стороне reduce-scatter. То есть `--enable-torch-symm-mem` здесь не обязателен, но именно он открывает быстрый путь; на NVSwitch-хосте включать его вместе с этим флагом имеет смысл.

Отдельная деталь: при включенном флаге `TorchSymmMemCommunicator` поднимает свой `max_size` до 512 МиБ (вместо 256 МиБ, которые ставит `SGLANG_OPT_USE_INKLING_CUSTOM_AR` сам по себе) — слитые extend-ядра работают out-of-place, поэтому выходная область буфера должна вмещать тот же максимальный prefill-пейлоад, что и входная.

### Что отключается

Флаг взаимно исключает две другие оптимизации Inkling, и это явно закодировано:

- `ar_sconv_norm_fusable` (слияние decode-цепочки `AR → sconv → norm`) возвращает `False` при включенном флаге — слияние полноширинное;
- `ar_fullwidth_sconv_fusable` тоже требует выключенного флага;
- вместо них включается `scattered_ar_sconv_fusable` — слияние `reduce_scatter_hidden → sconv(shard) → all_gather_hidden` в одно ядро, но только если заданы `SGLANG_OPT_USE_INKLING_CUSTOM_AR=1` и `SGLANG_OPT_USE_INKLING_FUSED_AR_SCONV=1`.

Без этих переменных окружения цепочка работает нефьюженной: три отдельные операции вместо одного ядра.

### Требования к топологии

Специальных требований нет: reduce-scatter и all-gather выполняются по обычной attention-TP-группе. NVLink/NVSwitch нужен только для быстрого multimem-пути через torch symmetric memory; на PCIe-хосте всё сведется к NCCL-коллективам, и выигрыш останется только по памяти.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- При `--tp-size 1` флаг инертен: `reduce_scatter_hidden` и `all_gather_hidden` выходят по `world_size == 1`, ширина свертки не меняется.
- `hidden_size` модели обязан делиться на размер attention-TP-группы — иначе ассерт при построении слоя, а не понятная ошибка разбора аргументов.
- У модели должен быть включен `use_sconv` в конфиге — иначе ассерт `--enable-scattered-sconv requires use_sconv`.

## Когда использовать

- Модель Inkling на нескольких картах, где conv-кеш заметно давит на бюджет: он масштабируется как `max_running_requests × (kernel_size − 1) × hidden_size` и на большой конкурентности не мал. Флаг делит его выходную часть на `tp_size`.
- В связке с `--enable-torch-symm-mem` на NVSwitch-хосте — тогда и коммуникация идет multimem-путем.
- Не включайте на любой другой архитектуре: значение просто никто не прочитает.
- Не включайте, если вы полагаетесь на слияние decode-цепочки `AR → sconv → norm` (переменные `SGLANG_OPT_USE_INKLING_*`): флаг его отключает и заменяет другим слиянием, у которого свои условия.
- Не ждите экономии коммуникации: справка прямо говорит «without changing communication volume».

## Влияние на производительность и память

- **VRAM.** Основной выигрыш: кеш состояний выходных сверток (`stream_dim`) делится на `tp_size`, вместе с весами `ShortConvolution`. Входные k/v-свертки шардируются по числу KV-голов и от флага не зависят.
- **Latency.** Нейтрально в теории (тот же объем передачи) и зависит от того, доступен ли слитый scattered-путь. Без `SGLANG_OPT_USE_INKLING_FUSED_AR_SCONV` вы платите за два коллектива вместо одного all-reduce плюс отдельную свертку — на decode это может оказаться дороже.
- **Throughput.** Косвенный выигрыш: освободившаяся память уходит в KV-пул, значит выше допустимая конкурентность.
- **Время старта.** Не меняется.
- **Хост.** Не меняется.

## Взаимодействие с другими аргументами

- `--tp-size`: определяет, на сколько частей делится скрытая размерность; при 1 флаг не делает ничего.
- `--enable-torch-symm-mem`: открывает multimem-путь для reduce-scatter/all-gather и поднимает лимит буфера до 512 МиБ.
- `--enable-dp-attention`: свертки шардируются по attention-TP-группе, а ее размер при DP-attention равен `tp_size // dp_size // attn_cp_size` — учитывайте это в требовании делимости `hidden_size`.
- `--max-running-requests`: вместе с длиной ядра свертки определяет размер conv-кеша, то есть величину экономии.
- `--disable-custom-all-reduce`: на scattered-путь не влияет — там своя пара коллективов.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: --enable-scattered-sconv requires use_sconv`. **Причина:** у модели в конфиге нет коротких сверток. **Решение:** убрать флаг.
- **Симптом:** `AssertionError: hidden_size <H> not divisible by attn tp <P>`. **Причина:** несовместимая нарезка. **Решение:** сменить `--tp-size` (или размер attention-TP-группы при DP-attention).
- **Симптом:** флаг задан на не-Inkling-модели, ничего не изменилось. **Причина:** значение читают только слои Inkling.
- **Симптом:** decode стал медленнее. **Причина:** нефьюженная цепочка из-за отсутствующих `SGLANG_OPT_USE_INKLING_CUSTOM_AR` / `SGLANG_OPT_USE_INKLING_FUSED_AR_SCONV`, при том что полноширинное слияние флагом отключено.
- **Что смотреть:** итоговый дамп `server_args=` при старте (принят ли флаг) и строка о размере выделенного кеша состояний — она и покажет фактическую экономию.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/inkling --tensor-parallel-size 4 --enable-scattered-sconv
```

```bash
python -m sglang.launch_server --model-path /models/inkling --tensor-parallel-size 8 --enable-scattered-sconv --enable-torch-symm-mem
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/inkling.py`
- `sglang/python/sglang/srt/models/inkling.py`
- `sglang/python/sglang/srt/models/inkling_common/attn.py`
- `sglang/python/sglang/srt/models/inkling_common/dense_mlp.py`
- `sglang/python/sglang/srt/models/inkling_common/moe.py`
- `sglang/python/sglang/srt/models/inkling_common/kernels/comm.py`
- `sglang/python/sglang/srt/distributed/device_communicators/torch_symm_mem.py`
