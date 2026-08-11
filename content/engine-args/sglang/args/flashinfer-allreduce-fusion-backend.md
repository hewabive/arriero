---
schema: 1
engine: sglang
primaryName: "--flashinfer-allreduce-fusion-backend"
title: "--flashinfer-allreduce-fusion-backend"
summary: Включает слияние all-reduce с Residual + RMSNorm через FlashInfer и выбирает транспорт: `trtllm` (одноузловой) или `mnnvl` (NVLink-фабрика Blackwell, в том числе многоузловая). Для полутора десятка MoE-архитектур на SM90/SM100 значение `auto` подставляется автоматически, поэтому чаще этот флаг используют, чтобы понять, почему фьюжен включился сам.
group: exec.comm
related:
  - --enforce-disable-flashinfer-allreduce-fusion
  - --enable-aiter-allreduce-fusion
  - --enable-deterministic-inference
  - --enable-dp-attention
  - --moe-a2a-backend
  - --tp-size
  - --nnodes
  - --disable-custom-all-reduce
  - --disable-flashinfer-autotune
---

# --flashinfer-allreduce-fusion-backend

## Кратко

Флаг решает две задачи одним значением: включает FlashInfer-фьюжен `allreduce + residual + RMSNorm` (само наличие непустого значения и есть «включено») и выбирает, каким транспортом фьюжен пользуется. `trtllm` — ядро TensorRT-LLM, только внутри одного узла. `mnnvl` — путь через MNNVL-фабрику: на SM100/SM103 он работает и внутри узла, и между узлами, на SM90 — только внутри узла. `auto` разворачивается в `mnnvl` на Blackwell и в `trtllm` на Hopper. Отдельно надо помнить, что для списка MoE-архитектур движок сам подставляет `auto`, если вы ничего не задали, — так что «я этого не включал» здесь обычно неверно.

## Оригинальная справка

```text
Enable FlashInfer allreduce fusion and choose backend. Requires SM90 or SM10X NVIDIA GPUs. Defaults to auto. 'auto': choose mnnvl on Blackwell (SM100/SM103) systems (single- and multi-node) and trtllm on SM90 single-node systems. 'trtllm': available on single-node systems only. 'mnnvl': available on SM90 single-node systems and SM100/SM103 single-node or multi-node systems via MNNVL fabric. Fuses allreduce with Residual + RMSNorm for supported MoE models.
```

## Паспорт аргумента

- Флаги: `--flashinfer-allreduce-fusion-backend`
- Группа: `exec.comm`
- Тип значения: строка с фиксированным списком (`Optional[Literal[...]]`)
- Допустимые значения: `auto`, `trtllm`, `mnnvl`
- Значение по умолчанию: `null` — фьюжен выключен
- Эффективное значение: переписывается тремя проходами реестра `arg_groups/overrides.py`, в этом порядке:
  1. `_flashinfer_allreduce_fusion_auto_enable` ставит `"auto"`, если значение не задано, архитектура входит в `_FLASHINFER_ALLREDUCE_FUSION_ARCHS`, платформа SM90 или SM100, `tp_size > 1`, DP-attention выключен, `moe_a2a_backend == "none"` и либо `nnodes == 1`, либо платформа SM100. В лог идет `Auto-enabling FlashInfer AllReduce Fusion on SM90/SM10X for <Arch>`;
  2. `_enforce_disable_allreduce_fusion` сбрасывает значение в `None`, если задан `--enforce-disable-flashinfer-allreduce-fusion`;
  3. `_deterministic_allreduce_fusion_disable` сбрасывает в `None` при `--enable-deterministic-inference` (`Disable --flashinfer-allreduce-fusion-backend because deterministic inference is enabled.`).

  Плюс устаревший флаг `--enable-flashinfer-allreduce-fusion` (см. ниже) в `_handle_deprecated_args` ставит `"auto"`
- Где объявлен: `ServerArgs.flashinfer_allreduce_fusion_backend`, файл — `sglang/python/sglang/srt/server_args.py`; поле помечено `resolvable=True`
- Статус: обычный. Его предшественник `--enable-flashinfer-allreduce-fusion` остается рабочим флагом командной строки: поле датакласса помечено `Arg(no_cli=True)`, чтобы не регистрироваться автоматически, а сам флаг объявлен литеральным `parser.add_argument` в `add_cli_args` — поэтому он есть и в `--help`, и в extract (описан в `enable-flashinfer-allreduce-fusion.md`). При его использовании `_handle_deprecated_args` печатает `--enable-flashinfer-allreduce-fusion is deprecated. Please use --flashinfer-allreduce-fusion-backend=auto instead.` и подставляет сюда `auto`. В новых строках запуска задавайте `--flashinfer-allreduce-fusion-backend auto` напрямую
- Этап применения: разбор CLI → `_handle_deprecated_args` → реестр переопределений (`auto`-включение, enforce-disable, детерминизм) → `_pre_initialize_flashinfer_allreduce_workspace` до захвата CUDA graph → каждый forward

## Что меняет в движке

### Разрешение значения в транспорт

`resolve_flashinfer_allreduce_fusion_backend` (`layers/flashinfer_comm_fusion.py`) переводит значение в конкретный backend с учетом `--nnodes`:

- вне SM90/SM100 — `ValueError: FlashInfer allreduce fusion requires SM90 or SM10X NVIDIA GPUs.`;
- `auto` + многоузловой запуск: `mnnvl` на SM100, иначе `ValueError: FlashInfer allreduce fusion does not support multi-node on non-Blackwell systems.`;
- `auto` + один узел: `mnnvl` на SM100, `trtllm` на SM90;
- `trtllm` + `--nnodes > 1` — `ValueError: FlashInfer allreduce fusion trtllm backend supports single-node only.`;
- `mnnvl` вне Blackwell и не «SM90 на одном узле» — `ValueError: FlashInfer allreduce fusion mnnvl backend requires a Blackwell system, or SM90 single-node.`

Это жесткие отказы: сервер не стартует.

### Что заменяет в пути all-reduce

`apply_flashinfer_allreduce_fusion(batch_size)` в `layers/communicator.py` — предикат на каждый вызов: платформа SM90/SM100, FlashInfer доступен, DP-attention выключен, значение флага не `None`, фьюжен не помечен недоступным, и `0 < batch_size <= FUSE_ALLREDUCE_MAX_BATCH_SIZE` (2048 токенов). Если предикат истинен и у слоя нормализации есть `forward_with_allreduce_fusion`, вместо цепочки «all-reduce → residual → RMSNorm» вызывается одно ядро FlashInfer, а обычный выбор пути (`ca → qr → pymscclpp → torch_symm_mem → pynccl`) для этих слоев не выполняется. За порогом в 2048 токенов — то есть на большинстве длинных prefill-чанков — работает обычный путь.

### Workspace

Буферы фьюжена выделяются до захвата CUDA graph, отдельным шагом `_pre_initialize_flashinfer_allreduce_workspace` (`model_executor/runner/base_runner.py`) — иначе broadcast/barrier внутри захвата дедлочился бы с регистрацией графовых буферов custom all-reduce. Размер считается по `FUSE_ALLREDUCE_MAX_BATCH_SIZE`, `hidden_size` модели и dtype; workspace пересоздается, если меняются world size, ранг, группа или требуемый размер. Группа передается явно (`device_group`/`cpu_group` координатора): без этого FlashInfer 0.6.10+ молча делал бы rendezvous на WORLD и адресовал не тех соседей в TP/EP/CP-конфигурациях.

### Требования к топологии

- `trtllm`: одноузловой NVLink/NVSwitch-домен. Межузлового варианта нет.
- `mnnvl`: NVLink-фабрика Multi-Node NVLink (GB200 NVL и родственные системы) для межузлового режима; на SM90 разрешен только одноузловой вариант. RDMA-транспорт здесь ни при чем — фьюжен работает поверх NVLink, а не поверх сети.

Мягких откатов у выбора backend'а нет: несовпадение железа и значения — это `ValueError` на старте. Мягко деградирует только доступность самого FlashInfer: если `flashinfer.comm.allreduce_fusion` в установленном пакете отсутствует, модуль печатает `flashinfer.comm unified allreduce_fusion API is not available, falling back to standard implementation` и предикат навсегда становится ложным.

## Значения и формат

- Одно из трех значений; всё остальное отвергает argparse (`invalid choice`).
- Отсутствие флага (`null`) означает «выключено», **если** архитектура модели не входит в список авто-включения. «Auto» строкой задать можно и нужно писать именно `auto` — это значение из списка, а не синоним отсутствия.
- Выключить авто-включение можно только `--enforce-disable-flashinfer-allreduce-fusion`; передать «пустое» значение этому флагу нельзя.

## Когда использовать

- Модель из списка авто-включения, но условия не сошлись (например, вы явно задали `--moe-a2a-backend`) и вы все равно хотите фьюжен — задайте `auto` явно и убедитесь, что запуск не падает.
- Многоузловой Blackwell с MNNVL — единственная конфигурация, где `mnnvl` осмысленно задавать руками.
- Hopper с одним узлом: `trtllm` эквивалентен `auto`, задавать явно нужно только ради читаемости конфигурации.
- Не задавайте фьюжен вместе с `--enable-dp-attention`: предикат явно требует выключенного DP-attention, фьюжен не сработает ни разу, а workspace все равно будет выделен.
- Не переносите значение между машинами разных поколений: `trtllm`, попавший на многоузловой запуск, и `mnnvl` на Ada — гарантированный отказ на старте.

## Влияние на производительность и память

- **Latency.** Основной эффект: одно ядро вместо трех на хвосте каждого блока, минус лишние обходы HBM. Работает только на батчах до 2048 токенов, то есть в первую очередь на decode.
- **VRAM.** Workspace FlashInfer размером порядка `FUSE_ALLREDUCE_MAX_BATCH_SIZE × hidden_size × itemsize` (с запасом на lamport-буферы) на каждый ранг, выделяется до захвата графов. На модели с `hidden_size` 8192 в bf16 это единицы сотен МиБ; при `use_fp32_lamport` — больше.
- **Throughput.** На длинных prefill-чанках эффекта нет: батч выходит за порог.
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

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: FlashInfer allreduce fusion requires SM90 or SM10X NVIDIA GPUs.` **Причина:** флаг на Ada/Ampere. **Решение:** убрать.
- **Симптом:** `ValueError: FlashInfer allreduce fusion trtllm backend supports single-node only.` **Причина:** `trtllm` при `--nnodes > 1`. **Решение:** `mnnvl` (если Blackwell) или убрать флаг.
- **Симптом:** в логе `Auto-enabling FlashInfer AllReduce Fusion on SM90/SM10X for Qwen3MoeForCausalLM`, хотя флаг не задавали. **Причина:** архитектура в списке авто-включения. **Решение:** если фьюжен не нужен — `--enforce-disable-flashinfer-allreduce-fusion`.
- **Симптом:** предупреждение `flashinfer.comm allreduce_fusion API is not available (…)`. **Причина:** установленный FlashInfer старше требуемого. **Следствие:** фьюжен не работает, но и не падает.
- **Симптом:** дедлок на захвате CUDA graph. **Причина:** workspace не был предвыделен (актуально при правках кода); в штатной сборке это как раз то, что предотвращает `_pre_initialize_flashinfer_allreduce_workspace`.
- **Что смотреть:** итоговый дамп `server_args=` при старте покажет разрешенное значение поля (`auto`/`trtllm`/`mnnvl`/`None`) — именно там видно результат авто-включения и всех сбросов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tensor-parallel-size 8 --flashinfer-allreduce-fusion-backend auto
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tensor-parallel-size 8 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.1:20000 --flashinfer-allreduce-fusion-backend mnnvl
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/flashinfer_comm_fusion.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/layers/layernorm.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
