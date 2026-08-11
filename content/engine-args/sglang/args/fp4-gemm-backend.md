---
schema: 1
engine: sglang
primaryName: "--fp4-gemm-backend"
title: "--fp4-gemm-backend"
summary: Выбирает ядро для NVFP4-линейных слоев. Работает только на моделях с FP4-квантизацией (modelopt NVFP4, compressed-tensors W4A4); значение влияет и на подготовку весов при загрузке, поэтому его нельзя менять «на лету» без перезапуска.
group: exec.kernel
related:
  - --quantization
  - --fp8-gemm-backend
  - --bf16-gemm-backend
  - --moe-runner-backend
  - --disable-flashinfer-autotune
  - --kv-cache-dtype
---

# --fp4-gemm-backend

## Кратко

`--fp4-gemm-backend` выбирает, какое ядро считает линейные слои в NVFP4. Аргумент имеет смысл только на FP4-квантованной модели (`modelopt_fp4`, `modelopt_mixed`, схема `compressed-tensors` W4A4 NVFP4). Важная особенность по сравнению с `--fp8-gemm-backend`: значение читается не только на forward, но и при загрузке весов — `flashinfer_trtllm` требует другой раскладки (шафл), а `marlin` — своей упаковки. Поэтому смена значения означает другую подготовку чекпоинта в памяти, а не просто другой вызов.

## Оригинальная справка

```text
Choose the runner backend for NVFP4 GEMM operations. Options: 'auto' (default; selects flashinfer_cutedsl on SM100, marlin on SM80-SM90, flashinfer_cutlass otherwise (including SM120)), 'flashinfer_cutlass' (FlashInfer CUTLASS backend), 'flashinfer_cudnn' (FlashInfer cuDNN backend, optimal on CUDA 13+ with cuDNN 9.15+), 'flashinfer_cutedsl' (FlashInfer CuTe DSL backend), 'flashinfer_trtllm' (FlashInfer TensorRT-LLM backend, requires different weight preparation with shuffling), 'marlin' (weight-only W4A16 fallback for SM80+). 
```

## Паспорт аргумента

- Флаги: `--fp4-gemm-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `auto`, `flashinfer_cudnn`, `flashinfer_cutedsl`, `flashinfer_cutlass`, `flashinfer_trtllm`, `marlin` (константа `FP4_GEMM_RUNNER_BACKEND_CHOICES`)
- Значение по умолчанию: `auto`
- Эффективное значение: `initialize_fp4_gemm_config` (`sglang/python/sglang/srt/layers/quantization/fp4_utils.py`) разворачивает `auto` сразу и полностью — `flashinfer_cutedsl` на SM100, `marlin` на CUDA с capability от 8.0 до 10.0 (то есть SM80–SM90), `flashinfer_cutlass` во всех остальных случаях, включая SM120. В отличие от FP8-ветки, «отложенного auto» здесь не остается
- Где объявлен: `ServerArgs.fp4_gemm_runner_backend` (имя поля не совпадает с флагом, `cli_name="--fp4-gemm-backend"`), файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `initialize_fp4_gemm_config` при инициализации планировщика → `process_weights_after_loading` квант-метода (раскладка весов) → каждый forward

## Что меняет в движке

Значение хранится глобально как `Fp4GemmRunnerBackend` и читается через `get_fp4_gemm_runner_backend()`.

- **Вызов ядра.** `modelopt_quant.py` берет `fp4_backend.get_flashinfer_backend()` — маппинг имен SGLang на имена FlashInfer API (`flashinfer_trtllm` → `trtllm`, `flashinfer_cutlass` → `cutlass`, `flashinfer_cudnn` → `cudnn`, `flashinfer_cutedsl` → `cute-dsl`) — и передает его в `flashinfer.mm_fp4`. Если FlashInfer не установлен, вызов бросает `RuntimeError: NVFP4 GEMM requires flashinfer's mm_fp4; please install flashinfer.` — то есть отказ приходит на forward, а не на старте.
- **Подготовка весов.** `ModelOptNvFp4LinearMethod.process_weights_after_loading` ветвится по `is_marlin()` и `is_flashinfer_trtllm()`: marlin переупаковывает веса через `prepare_nvfp4_layer_for_marlin` (и требует `group_size=16`, иначе `ValueError: NVFP4 Marlin requires group_size=16`), trtllm выполняет шафл (`shuffle_matrix_a` / `shuffle_matrix_sf_a`) с паддингом N до 128. То же делает схема `compressed_tensors_w4a4_nvfp4`. Это происходит один раз при загрузке модели и определяет, сколько памяти займут веса и какое ядро вообще применимо дальше.
- **Проверка железа.** Она есть, но срабатывает именно здесь, на загрузке весов, а не при разборе аргументов: любой не-`marlin` backend на не-Blackwell карте дает `ValueError: ModelOpt NVFP4 native dense GEMM backends require SM100+. Use --fp4-gemm-backend marlin on SM80-SM90.`
- **MoE.** `sglang/python/sglang/srt/models/inkling_common/moe.py` отдельно проверяет `is_marlin()`; в остальном экспертные GEMM управляются `--moe-runner-backend`, а не этим флагом.
- **Автотюнинг.** `should_run_flashinfer_autotune` включает прогон, если модель в `modelopt_fp4`/`modelopt_mixed` **и** разрешенный FP4-раннер — `flashinfer_cutlass` или `flashinfer_cutedsl`.
- В самом `initialize_fp4_gemm_config` проверок нет: значение принимается как есть, и несовместимость всплывает на загрузке весов (проверка SM100+ выше) либо на первом forward (отсутствие FlashInfer). Это отличается от `--fp8-gemm-backend`, где явное значение проверяется сразу при инициализации планировщика.

Отдельно от этого аргумента существует FP4 **KV-кеш** (`--kv-cache-dtype nvfp4` / `fp4_mx_block16`) со своими требованиями к attention backend'ам — это разные подсистемы, не путайте их.

## Значения и формат

- `auto` — рекомендуемое; полностью разрешается по compute capability, см. выше.
- `marlin` — weight-only W4A16: активации остаются в высокой точности, экономится только память весов. Это fallback для SM80–SM90, где нативных FP4-тензорных ядер нет.
- `flashinfer_trtllm` — требует шафла весов; переключение на него и с него меняет подготовку чекпоинта.
- `flashinfer_cudnn` — по справке оптимален на CUDA 13+ с cuDNN 9.15+; проверки версии в SGLang нет, ее делает FlashInfer.
- Значение вне списка отвергает argparse. Значение из списка, неподходящее для карты, отвергается на загрузке весов; недоступное в установленном FlashInfer — на первом forward.

## Когда использовать

- Задавайте явно, когда сравниваете ядра на Blackwell (`flashinfer_cutedsl` против `flashinfer_cutlass` против `flashinfer_trtllm`) или когда апстрим рекомендует конкретный вариант под вашу модель.
- Задавайте `marlin` осознанно на SM80–SM90: это единственный работающий путь для FP4-чекпоинта на до-Blackwell картах, но по вычислениям он W4A16, а не W4A4.
- Не задавайте на не-FP4 модели: флаг не будет прочитан.
- Не меняйте значение «на живом» инстансе в надежде на эффект без перезапуска: раскладка весов фиксируется при загрузке.

## Влияние на производительность и память

- **VRAM весов.** Разные backend'ы держат веса в разной раскладке; `marlin` дополнительно материализует свою упаковку в `process_weights_after_loading`. Это единственный из трех GEMM-аргументов, который заметно влияет на память.
- **Throughput/latency.** Основной эффект на плотных слоях FP4-модели; для MoE решающим остается `--moe-runner-backend`.
- **Время старта.** Переупаковка весов на загрузке плюс, для CuTe DSL, JIT-компиляция; при `flashinfer_cutlass`/`flashinfer_cutedsl` еще и прогон автотюнинга.
- **Точность.** `marlin` считает в W4A16 — это другой численный режим по сравнению с настоящими FP4-ядрами.

## Взаимодействие с другими аргументами

- `--quantization`: FP4-путь существует только для `modelopt_fp4`/`modelopt_mixed` и совместимых схем `compressed-tensors`.
- `--fp8-gemm-backend`, `--bf16-gemm-backend`: соседние аргументы для других форматов.
- `--moe-runner-backend`: у экспертов свой реестр раннеров; для FP4-MoE там свои ограничения (в частности, `auto` + `modelopt_fp4` + SM120 разрешается в `flashinfer_cutlass`).
- `--disable-flashinfer-autotune` / `--flashinfer-autotune-skip-ops`: определяют, будут ли выбранные FlashInfer-ядра оттюнены.
- `--kv-cache-dtype`: FP4 KV-кеш — независимая от этого флага подсистема со своими проверками.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: NVFP4 GEMM requires flashinfer's mm_fp4; please install flashinfer.` на первом запросе. **Причина:** FP4-ядро выбрано, а FlashInfer не установлен. **Решение:** поставить FlashInfer или взять `marlin`.
- **Симптом:** `ValueError: ModelOpt NVFP4 native dense GEMM backends require SM100+. Use --fp4-gemm-backend marlin on SM80-SM90.` при загрузке весов. **Причина:** явный не-marlin backend на до-Blackwell карте.
- **Симптом:** `ValueError: NVFP4 Marlin requires group_size=16, got …`. **Причина:** чекпоинт квантован с другим размером группы; marlin для него неприменим.
- **Симптом:** на SM80–SM90 FP4-модель работает медленнее ожидаемого. **Причина:** `auto` выбрал `marlin`, то есть W4A16.
- **Симптом:** после смены значения выросло потребление VRAM на весах. **Причина:** другая раскладка/упаковка в `process_weights_after_loading`.
- **Симптом:** флаг задан, эффекта нет. **Причина:** модель не FP4-квантована либо основная стоимость в MoE-слоях.
- **Проверка:** дамп `server_args=` при старте показывает заданное значение поля `fp4_gemm_runner_backend`; разрешение `auto` в дампе не видно и определяется compute capability карты.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1-NVFP4 --quantization modelopt_fp4 --fp4-gemm-backend flashinfer_cutedsl
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1-NVFP4 --quantization modelopt_fp4 --fp4-gemm-backend marlin
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/quantization/fp4_utils.py`
- `sglang/python/sglang/srt/layers/quantization/modelopt_quant.py`
- `sglang/python/sglang/srt/layers/quantization/compressed_tensors/schemes/compressed_tensors_w4a4_nvfp4.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
- `sglang/docs/docs/advanced_features/quantization.mdx`
