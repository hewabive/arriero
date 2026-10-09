---
schema: 1
engine: sglang
primaryName: "--flashinfer-allreduce-fusion-backend"
title: "--flashinfer-allreduce-fusion-backend"
summary: Включает слияние all-reduce с Residual + RMSNorm через FlashInfer и выбирает транспорт: `trtllm` (одноузловой), `mnnvl` (NVLink-фабрика Blackwell, в том числе многоузловая) или `cutedsl` (CuTe DSL-ядра MNNVL на Blackwell, которые дополнительно вбирают MoE finalize и shared expert). Для полутора десятков MoE-архитектур на SM90/SM100 значение `auto` подставляется автоматически, поэтому чаще этот флаг используют, чтобы понять, почему фьюжен включился сам.
group: exec.comm
related:
  - --enforce-disable-flashinfer-allreduce-fusion
  - --enable-flashinfer-allreduce-fusion
  - --enable-aiter-allreduce-fusion
  - --enable-deterministic-inference
  - --enable-dp-attention
  - --moe-a2a-backend
  - --tp-size
  - --nnodes
  - --disable-custom-all-reduce
  - --disable-flashinfer-autotune
  - --disable-shared-experts-fusion
  - --enable-pdmux
  - --enable-mscclpp
  - --moe-runner-backend
---

# --flashinfer-allreduce-fusion-backend

## Кратко

Флаг решает две задачи одним значением: включает FlashInfer-фьюжен `allreduce + residual + RMSNorm` (само наличие непустого значения и есть «включено») и выбирает, каким транспортом фьюжен пользуется. `trtllm` — ядро TensorRT-LLM, только внутри одного узла. `mnnvl` — путь через MNNVL-фабрику: на SM100/SM103 он работает и внутри узла, и между узлами, на SM90 — только внутри узла. `auto` разворачивается в `mnnvl` на Blackwell и в `trtllm` на Hopper. `cutedsl` — отдельная реализация на CuTe DSL-ядрах FlashInfer, только Blackwell и только bf16: помимо all-reduce + residual + RMSNorm она умеет вбирать в тот же коллектив MoE finalize и добавление shared expert, но работает лишь для моделей, которые ее встраивают (семейство `deepseek_v2.py` — DeepSeek V2/V3, GLM-5.x — и Qwen3.5-MoE), и никогда не выбирается автоматически. Отдельно надо помнить, что для списка MoE-архитектур движок сам подставляет `auto`, если вы ничего не задали, — так что «я этого не включал» здесь обычно неверно.

## Оригинальная справка

```text
Enable FlashInfer allreduce fusion and choose backend. Requires SM90 or SM10X NVIDIA GPUs. Defaults to auto. 'auto': choose mnnvl on Blackwell (SM100/SM103) systems (single- and multi-node) and trtllm on SM90 single-node systems. 'trtllm': available on single-node systems only. 'mnnvl': available on SM90 single-node systems and SM100/SM103 single-node or multi-node systems via MNNVL fabric. 'cutedsl': Blackwell-only bf16 MNNVL CuTe DSL backend; also fuses the MoE finalize and the shared-expert add into the collective when the MoE runner can defer them. Fuses allreduce with Residual + RMSNorm for supported MoE models.
```

## Паспорт аргумента

- Флаги: `--flashinfer-allreduce-fusion-backend`
- Группа: `exec.comm`
- Тип значения: строка с фиксированным списком (`Optional[Literal[...]]`)
- Допустимые значения: `auto`, `trtllm`, `mnnvl`, `cutedsl`
- Значение по умолчанию: `null` — фьюжен выключен
- Эффективное значение: переписывается тремя проходами реестра `arg_groups/overrides.py`, в этом порядке:
  1. `_flashinfer_allreduce_fusion_auto_enable` ставит `"auto"`, если значение не задано, архитектура входит в `_FLASHINFER_ALLREDUCE_FUSION_ARCHS`, платформа SM90 или SM100, `tp_size > 1`, DP-attention выключен, `moe_a2a_backend == "none"` и либо `nnodes == 1`, либо платформа SM100. Исключение — DeepSeek-V4.1 с `hidden_size` 5120 при TP4 на одном Blackwell-узле без `--disable-custom-all-reduce`: там предпочтен собственный custom-путь, и `auto` не ставится. Значение `cutedsl` авто-включение не подставляет никогда. В лог идет `Auto-enabling FlashInfer AllReduce Fusion on SM90/SM10X for <Arch>`;
  2. `_enforce_disable_allreduce_fusion` сбрасывает значение в `None`, если задан `--enforce-disable-flashinfer-allreduce-fusion`;
  3. `_deterministic_allreduce_fusion_disable` сбрасывает в `None` при `--enable-deterministic-inference` (`Disable --flashinfer-allreduce-fusion-backend because deterministic inference is enabled.`).

  Плюс устаревший флаг `--enable-flashinfer-allreduce-fusion` (см. ниже) в `_handle_deprecated_args` ставит `"auto"`. Прежняя переменная окружения `SGLANG_FLASHINFER_MNNVL_CUTEDSL_AR_FUSION`, включавшая CuTe DSL-фьюжен для Qwen3.5, теперь объявлена устаревшей с подсказкой задавать `--flashinfer-allreduce-fusion-backend cutedsl`; без флага подходящая модель получит `auto`, то есть `mnnvl`
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecComm.flashinfer_allreduce_fusion_backend`; поле помечено `resolvable=True`
- Статус: обычный. Его предшественник `--enable-flashinfer-allreduce-fusion` остается рабочим флагом командной строки: поле датакласса помечено `Arg(no_cli=True)`, чтобы не регистрироваться автоматически, а сам флаг объявлен литеральным `parser.add_argument` в `add_cli_args` — поэтому он есть и в `--help`, и в extract (описан в `enable-flashinfer-allreduce-fusion.md`). При его использовании `_handle_deprecated_args` печатает `--enable-flashinfer-allreduce-fusion is deprecated. Please use --flashinfer-allreduce-fusion-backend=auto instead.` и подставляет сюда `auto`. В новых строках запуска задавайте `--flashinfer-allreduce-fusion-backend auto` напрямую
- Этап применения: разбор CLI → `_handle_deprecated_args` → реестр переопределений (`auto`-включение, enforce-disable, детерминизм) → построение модели (для `cutedsl` — установка `CuteDSLFusion` в слои) → `_pre_initialize_flashinfer_allreduce_workspace` до захвата CUDA graph → каждый forward

## Что меняет в движке

### Разрешение значения в транспорт

`resolve_flashinfer_allreduce_fusion_backend` (`layers/flashinfer_comm_fusion.py`) переводит значение в конкретный backend с учетом `--nnodes`:

- вне SM90/SM100 — `ValueError: FlashInfer allreduce fusion requires SM90 or SM10X NVIDIA GPUs.`;
- `cutedsl` не на SM100 — `ValueError: FlashInfer allreduce fusion cutedsl backend requires a Blackwell system.`; на Blackwell значение проходит как есть, независимо от `--nnodes`;
- `auto` + многоузловой запуск: `mnnvl` на SM100, иначе `ValueError: FlashInfer allreduce fusion does not support multi-node on non-Blackwell systems.`;
- `auto` + один узел: `mnnvl` на SM100, `trtllm` на SM90;
- `trtllm` + `--nnodes > 1` — `ValueError: FlashInfer allreduce fusion trtllm backend supports single-node only.`;
- `mnnvl` вне Blackwell и не «SM90 на одном узле» — `ValueError: FlashInfer allreduce fusion mnnvl backend requires a Blackwell system, or SM90 single-node.`

Это жесткие отказы: сервер не стартует.

### Что заменяет в пути all-reduce

`apply_flashinfer_allreduce_fusion(batch_size)` в `layers/layer_boundary/residual/add_norm.py` — предикат на каждый вызов для `auto`/`trtllm`/`mnnvl`: платформа SM90/SM100, FlashInfer доступен, DP-attention выключен, значение флага не `None` и не `cutedsl`, фьюжен не помечен недоступным, и `0 < batch_size <= FUSE_ALLREDUCE_MAX_BATCH_SIZE` (2048 токенов). Если предикат истинен и у слоя нормализации есть `forward_with_allreduce_fusion`, вместо цепочки «all-reduce → residual → RMSNorm» вызывается одно ядро FlashInfer, а обычный выбор пути (`ca → qr → pymscclpp → torch_symm_mem → pynccl`) для этих слоев не выполняется. За порогом в 2048 токенов — то есть на большинстве длинных prefill-чанков — работает обычный путь.

### `cutedsl`

При `cutedsl` прежний путь выключен целиком: предикат выше ложен, легаси-workspace не создается, и `set_flashinfer_allreduce_only` не взводится. Вместо этого модель при построении ставит в слои `CuteDSLFusion` (`layers/layer_boundary/fusions/cutedsl.py`), а `prepare_cutedsl_fusion` до захвата графов создает один общий workspace (`layers/flashinfer_mnnvl_cutedsl.py`). Встраивают его только `deepseek_v2.py` (кроме MTP/NextN-слоев и prefill CP) и Qwen3.5-MoE (`qwen3_5_moe_text`); если модель ничего не установила, старт падает с `ValueError: --flashinfer-allreduce-fusion-backend cutedsl is set, but <Model> installed no CuTe DSL fusion service…`.

На каждом слое фьюжен срабатывает, если режим forward — DECODE, EXTEND или TARGET_VERIFY, число токенов не превышает `M_max` workspace (максимум из `--max-running-requests`, размеров CUDA graph и токенного бюджета CuteDSL MoE), DP-attention выключен, attention CP равен 1, `--moe-a2a-backend none` и `tp_size > 1`. Два шаблона делят workspace: all-reduce + residual + RMSNorm и тот же шаблон со вложенными MoE finalize и shared expert — второй только при `moe_ep_size == 1`, когда MoE-слой умеет отложить finalize (`--moe-runner-backend flashinfer_trtllm` с NVFP4-весами либо, у Qwen3.5, с блочным FP8), а shared expert не слит в routed MoE. Поэтому при `cutedsl` у Qwen3.5 слияние shared experts отключается, а у DeepSeek V3/R1 с включенным по умолчанию слиянием shared experts фьюзятся только all-reduce + norm. Workspace поддерживает TP 2, 4, 8 и 16 и только bf16; для формы, под которую FlashInfer не поставляет профиль, логируется `MNNVL CuTe DSL: no shipped profile for tp=… hidden=… top_k=…` с советом сравнить с `mnnvl`.

### Workspace

Буферы фьюжена (для `auto`/`trtllm`/`mnnvl`) выделяются до захвата CUDA graph, отдельным шагом `_pre_initialize_flashinfer_allreduce_workspace` (`model_executor/runner/base_runner.py`) — иначе broadcast/barrier внутри захвата дедлочился бы с регистрацией графовых буферов custom all-reduce. Размер считается по `FUSE_ALLREDUCE_MAX_BATCH_SIZE`, `hidden_size` модели и dtype; workspace пересоздается, если меняются world size, ранг, группа или требуемый размер. Группа передается явно (`device_group`/`cpu_group` координатора): без этого FlashInfer 0.6.10+ молча делал бы rendezvous на WORLD и адресовал не тех соседей в TP/EP/CP-конфигурациях.

### Требования к топологии

- `trtllm`: одноузловой NVLink/NVSwitch-домен. Межузлового варианта нет.
- `mnnvl`: NVLink-фабрика Multi-Node NVLink (GB200 NVL и родственные системы) для межузлового режима; на SM90 разрешен только одноузловой вариант. RDMA-транспорт здесь ни при чем — фьюжен работает поверх NVLink, а не поверх сети.
- `cutedsl`: тот же MNNVL-транспорт, только Blackwell; поставляемые профили FlashInfer сняты на GB300 (TP8/16, `hidden_size` 8192, top-k 10), для других форм пресеты перенацеливаются без собственных замеров.

Мягких откатов у выбора backend'а нет: несовпадение железа и значения — это `ValueError` на старте. Мягко деградирует только доступность самого FlashInfer: если `flashinfer.comm.allreduce_fusion` в установленном пакете отсутствует, модуль печатает `flashinfer.comm unified allreduce_fusion API is not available, falling back to standard implementation` и предикат навсегда становится ложным.

## Значения и формат

- Одно из четырех значений; всё остальное отвергает argparse (`invalid choice`).
- Отсутствие флага (`null`) означает «выключено», **если** архитектура модели не входит в список авто-включения. «Auto» строкой задать можно и нужно писать именно `auto` — это значение из списка, а не синоним отсутствия.
- Выключить авто-включение можно только `--enforce-disable-flashinfer-allreduce-fusion`; передать «пустое» значение этому флагу нельзя.

## Когда использовать

- Модель из списка авто-включения, но условия не сошлись (например, вы явно задали `--moe-a2a-backend`) и вы все равно хотите фьюжен — задайте `auto` явно и убедитесь, что запуск не падает.
- Многоузловой Blackwell с MNNVL — единственная конфигурация, где `mnnvl` осмысленно задавать руками.
- Hopper с одним узлом: `trtllm` эквивалентен `auto`, задавать явно нужно только ради читаемости конфигурации.
- Blackwell, bf16, модель семейства DeepSeek V2/V3/GLM-5.x или Qwen3.5-MoE, TP 2–16 без DP-attention и без A2A-backend'а — кандидат на `cutedsl`. Выигрыш от вложенного MoE finalize заметен на малых батчах; перед продом сравните с `mnnvl` на своей форме модели.
- Не задавайте фьюжен вместе с `--enable-dp-attention`: предикат явно требует выключенного DP-attention, фьюжен не сработает ни разу, а workspace все равно будет выделен.
- Не переносите значение между машинами разных поколений: `trtllm`, попавший на многоузловой запуск, и `mnnvl` на Ada — гарантированный отказ на старте.

## Влияние на производительность и память

- **Latency.** Основной эффект: одно ядро вместо трех на хвосте каждого блока, минус лишние обходы HBM. Работает только на батчах до 2048 токенов, то есть в первую очередь на decode.
- **VRAM.** Workspace FlashInfer размером порядка `FUSE_ALLREDUCE_MAX_BATCH_SIZE × hidden_size × itemsize` (с запасом на lamport-буферы) на каждый ранг, выделяется до захвата графов. На модели с `hidden_size` 8192 в bf16 это единицы сотен МиБ; при `use_fp32_lamport` — больше.
- **Throughput.** На длинных prefill-чанках эффекта нет: батч выходит за порог. У `cutedsl` порог другой — `M_max` workspace, — зато вложенный MoE finalize экономит обход `[M × top_k, hidden]` через HBM, что окупается в основном на малых M.
- **VRAM у `cutedsl`.** Один workspace на процесс, размер по `M_max`, `hidden_size` и `top_k`; легаси-workspace при этом не выделяется.
- **Время старта.** Плюс инициализация workspace и rendezvous по группе.
- **Точность.** Слитое ядро считает редукцию и норму иначе, чем пара отдельных ядер, — поэтому детерминированный режим его снимает.

## Взаимодействие с другими аргументами

- `--enforce-disable-flashinfer-allreduce-fusion`: единственный способ отменить авто-включение; выполняется сразу после него.
- `--enable-deterministic-inference`: сбрасывает значение в `None` и дополнительно взводит `enforce_disable_flashinfer_allreduce_fusion` в `_handle_model_specific_adjustments`.
- `--enable-aiter-allreduce-fusion`: ROCm-аналог, проверяется в том же `or`; на одной платформе истинным может быть только один из двух.
- `--enable-dp-attention`: блокирует и авто-включение, и сам фьюжен на forward.
- `--moe-a2a-backend`: любое значение, кроме `none`, отменяет авто-включение (но не запрещает задать флаг руками).
- `--tp-size`: авто-включение требует значения больше 1.
- `--nnodes`: определяет допустимость `trtllm` и разрешение `auto`.
- `--disable-custom-all-reduce`: для слоев, забранных фьюженом, выбор пути и так не выполняется; на остальных коллективах флаги независимы.
- `--disable-flashinfer-autotune`: относится к автотюнингу ядер FlashInfer в целом; на разрешение backend'а фьюжена не влияет.
- `--disable-shared-experts-fusion`: при `cutedsl` у Qwen3.5 слияние shared experts отключается автоматически — отложенному finalize нужен shared expert отдельным вкладом.
- `--enable-pdmux`: с `cutedsl` несовместим — `RuntimeError` при подготовке workspace.
- `--enable-mscclpp`: FlashInfer allreduce проверяется раньше пути MSCCL++, поэтому забранные фьюженом тензоры до него не доходят.
- Спекулятивное декодирование: draft-воркер CuTe DSL-фьюжен не ставит, а при активной спекуляции workspace использует безопасный порядок загрузки shared expert (строка `Speculative decoding active: keeping the FlashInfer MNNVL CuTe DSL finalize presets…`).

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: FlashInfer allreduce fusion requires SM90 or SM10X NVIDIA GPUs.` **Причина:** флаг на Ada/Ampere. **Решение:** убрать.
- **Симптом:** `ValueError: FlashInfer allreduce fusion trtllm backend supports single-node only.` **Причина:** `trtllm` при `--nnodes > 1`. **Решение:** `mnnvl` (если Blackwell) или убрать флаг.
- **Симптом:** `ValueError: FlashInfer allreduce fusion cutedsl backend requires a Blackwell system.` **Причина:** `cutedsl` на Hopper. **Решение:** `auto` или `trtllm`.
- **Симптом:** `ValueError: --flashinfer-allreduce-fusion-backend cutedsl is set, but <Model> installed no CuTe DSL fusion service…`. **Причина:** модель не встраивает CuTe DSL-фьюжен. **Решение:** `auto`, `trtllm` или `mnnvl`.
- **Подтверждение `cutedsl`:** строки `Installed one <label> FlashInfer MNNVL CuTe DSL fusion handle for N of M layers (K can defer the MoE finalize)` и `Prepared the FlashInfer MNNVL CuTe DSL fusion workspace for M_max=…`.
- **Симптом:** в логе `Auto-enabling FlashInfer AllReduce Fusion on SM90/SM10X for Qwen3MoeForCausalLM`, хотя флаг не задавали. **Причина:** архитектура в списке авто-включения. **Решение:** если фьюжен не нужен — `--enforce-disable-flashinfer-allreduce-fusion`.
- **Симптом:** предупреждение `flashinfer.comm allreduce_fusion API is not available (…)`. **Причина:** установленный FlashInfer старше требуемого. **Следствие:** фьюжен не работает, но и не падает.
- **Симптом:** дедлок на захвате CUDA graph. **Причина:** workspace не был предвыделен (актуально при правках кода); в штатной сборке это как раз то, что предотвращает `_pre_initialize_flashinfer_allreduce_workspace`.
- **Что смотреть:** итоговый дамп `server_args=` при старте покажет разрешенное значение поля (`auto`/`trtllm`/`mnnvl`/`cutedsl`/`None`) — именно там видно результат авто-включения и всех сбросов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tensor-parallel-size 8 --flashinfer-allreduce-fusion-backend auto
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.1:20000 --flashinfer-allreduce-fusion-backend mnnvl
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3.5-397B-A17B --tensor-parallel-size 8 --flashinfer-allreduce-fusion-backend cutedsl
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/flashinfer_comm_fusion.py`
- `sglang/python/sglang/srt/layers/layer_boundary/residual/add_norm.py`
- `sglang/python/sglang/srt/layers/layer_boundary/fusions/cutedsl.py`
- `sglang/python/sglang/srt/layers/flashinfer_mnnvl_cutedsl.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`, `sglang/python/sglang/srt/models/qwen3_5.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- upstream PR #39816 «Refactor the Cute-DSL AR fusion to support DeepseekV2 archs (GLM-5.3, etc.)» (коммит `3177d10ca6` в checkout)
