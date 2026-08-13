---
schema: 1
engine: sglang
primaryName: "--fp8-gemm-backend"
title: "--fp8-gemm-backend"
summary: Выбирает ядро для blockwise-FP8 линейных слоев (и, частично, для MXFP8-плотных). Работает только на FP8-квантованной модели; явное значение проверяется жестко и падает на старте, если ядро недоступно на этом железе.
group: exec.kernel
related:
  - --quantization
  - --fp4-gemm-backend
  - --bf16-gemm-backend
  - --moe-runner-backend
  - --disable-flashinfer-autotune
  - --dtype
---

# --fp8-gemm-backend

## Кратко

`--fp8-gemm-backend` выбирает реализацию `w8a8_block_fp8_linear` — плотного FP8-GEMM с поблочными масштабами. Аргумент имеет смысл только на модели, чьи линейные слои реально квантованы в FP8 (`--quantization fp8`, blockwise-FP8-чекпоинты, `compressed-tensors` FP8, `modelopt`-FP8): к экспертам MoE он отношения не имеет, там свой `--moe-runner-backend`. Значение `auto` подбирается по доступности DeepGEMM и поколению карты; любое явное значение проходит проверку и при несовпадении с железом дает `RuntimeError` на старте планировщика.

## Оригинальная справка

```text
Choose the runner backend for Blockwise FP8 GEMM operations. Options: 'auto' (default, auto-selects based on hardware; MXFP8 dense picks flashinfer_cutedsl on SM100/SM103 and FlashInfer CUTLASS on other supported Blackwell GPUs), 'deep_gemm' (JIT-compiled; enabled by default on NVIDIA Hopper (SM90) and Blackwell (SM100) when DeepGEMM is installed), 'flashinfer_trtllm' (optimal for Blackwell and low-latency), 'flashinfer_cutlass' (FlashInfer CUTLASS groupwise FP8 GEMM), 'flashinfer_cutedsl' (FlashInfer CuTe DSL MXFP8 GEMM on SM100/SM103), 'flashinfer_deepgemm' (Hopper SM90 only; uses swapAB optimization for small M dimensions in decoding), 'cutlass' (optimal for SM120 GPUs), 'triton' (fallback, widely compatible), 'aiter' (ROCm only). 
```

## Паспорт аргумента

- Флаги: `--fp8-gemm-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `auto`, `deep_gemm`, `flashinfer_trtllm`, `flashinfer_cutlass`, `flashinfer_cutedsl`, `flashinfer_deepgemm`, `cutlass`, `triton`, `aiter` (константа `FP8_GEMM_RUNNER_BACKEND_CHOICES`). `flashinfer_cutedsl` — **только для MXFP8-плотных слоев**, на blockwise-FP8-пути его нет
- Значение по умолчанию: `auto`
- Эффективное значение: `initialize_fp8_gemm_config` (`sglang/python/sglang/srt/layers/quantization/fp8_utils.py`) переписывает `auto` только в одном случае — на `cutlass` при SM120. В остальных случаях `auto` остается `auto` и разрешается позже: для blockwise-FP8 в `_dispatch_auto_backend`, для MXFP8-плотных слоев в `resolve_mxfp8_dense_gemm_backend`, каждый в момент выбора функции
- Где объявлен: `ServerArgs.fp8_gemm_runner_backend` (обратите внимание: имя поля и имя флага не совпадают, `cli_name="--fp8-gemm-backend"`), файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`
- Этап применения: разбор CLI → `initialize_fp8_gemm_config` при инициализации планировщика → `dispatch_w8a8_block_fp8_linear` при построении квант-метода слоя → каждый forward

## Что меняет в движке

Значение хранится глобально как `Fp8GemmRunnerBackend` и читается через `get_fp8_gemm_runner_backend()`.

**`auto`** разрешается в `_dispatch_auto_backend()` строго по приоритету:

1. DeepGEMM, если включен JIT (`deep_gemm_wrapper.ENABLE_JIT_DEEPGEMM`);
2. FlashInfer TRT-LLM, если Blackwell и FlashInfer доступен;
3. CUTLASS, если SM120;
4. AITER, если ROCm с `SGLANG_USE_AITER=1`;
5. Triton — универсальный fallback.

**Явное значение** проходит `_dispatch_explicit_backend` и падает `RuntimeError`, если ядро недоступно:

| значение | требование | текст отказа при несоблюдении |
| --- | --- | --- |
| `flashinfer_trtllm` | SM100/SM103 + FlashInfer | `FlashInfer FP8 GEMM requested via --fp8-gemm-backend=flashinfer_trtllm, but FlashInfer is not available or not supported on this hardware.` |
| `flashinfer_cutlass` | Blackwell + FlashInfer | `… FlashInfer CUTLASS FP8 GEMM requires Blackwell GPUs and FlashInfer.` |
| `flashinfer_deepgemm` | SM90 + FlashInfer | `… This backend requires Hopper (SM90) GPUs and FlashInfer to be installed.` |
| `cutlass` | SM120 | `--fp8-gemm-backend=cutlass is deprecated on this hardware. Please switch to DeepGEMM or FlashInfer TRTLLM on SM90/SM100.` |
| `aiter` | ROCm + `SGLANG_USE_AITER=1` | `AITER backend requested via --fp8-gemm-backend=aiter, but AITER is not available.` |
| `deep_gemm` | доступный DeepGEMM JIT | `DeepGEMM backend requested via --fp8-gemm-backend=deep_gemm, but DeepGEMM is not available.` |
| `triton` | — | принимается всегда |
| `flashinfer_cutedsl` | **не поддерживается на этом пути** | `ValueError: Unknown FP8 GEMM backend: Fp8GemmRunnerBackend.FLASHINFER_CUTEDSL` |

Последняя строка — не опечатка: у `flashinfer_cutedsl` нет ветки в `_dispatch_explicit_backend`, поэтому на blockwise-FP8-модели он проваливается в финальный `else` и дает `ValueError` с невнятным текстом. Это ядро существует только для MXFP8.

Отдельная ветка — **MXFP8-плотные слои**, и с добавлением CuTe DSL она заметно изменилась. `resolve_mxfp8_dense_gemm_backend` учитывает флаг, когда он называет backend с MXFP8-ядром — теперь это `flashinfer_trtllm`, `flashinfer_cutedsl`, `flashinfer_cutlass` и `deep_gemm`, каждый со своей проверкой железа (`flashinfer_cutedsl` требует Blackwell, FlashInfer **и** положительный ответ `is_backend_supported("cute-dsl", sm)`). При прочих значениях, включая `auto`, он выбирает сам:

1. gfx95 на ROCm;
2. Blackwell с FlashInfer ⇒ `flashinfer_cutedsl`, если CuTe DSL поддержан на этом SM, иначе `flashinfer_cutlass`;
3. DeepGEMM, если доступен JIT;
4. иначе `_unsupported_mxfp8_linear`, который бросает исключение при первом вызове.

Раньше та же задача решалась двумя костылями, которых больше нет: `initialize_fp8_gemm_config` переписывал `auto` на `flashinfer_cutlass` при `--quantization mxfp8` на SM100, а на forward'е CUTLASS-путь подменялся на `cute-dsl` при `M <= 64`, потому что персистентное CUTLASS-ядро на малых M было в 2-5 раз медленнее. Теперь CuTe DSL — полноценный именованный backend, и выбор делается один раз при разрешении, а не по форме каждого вызова.

Флаг участвует и в решении про автотюнинг FlashInfer: `should_run_flashinfer_autotune` считает тюнинг нужным, если разрешенный FP8-GEMM-раннер — `flashinfer_cutlass` (или модель `modelopt`-FP8 на SM100/SM120).

Часть backend'ов имеет внутренние fallback'и на уровне формы задачи: `flashinfer_gemm_w8a8_block_fp8_linear_with_fallback` при `trtllm` и `K < 256` либо не-bf16 входе уходит в Triton прямо на forward.

## Значения и формат

- `auto` — рекомендуемое значение. Оно означает «выбрать доступное лучшее», а не конкретное ядро.
- `triton` — единственный вариант без требований к железу; он же самый медленный.
- `cutlass` в этой квантизации означает **SM120**, а не «CUTLASS вообще»: на SM90/SM100 он отвергается с рекомендацией взять DeepGEMM или FlashInfer TRT-LLM.
- `flashinfer_deepgemm` — узкий случай: swapAB для малых M на Hopper, то есть оптимизация декода.
- `flashinfer_cutedsl` — только MXFP8-плотные слои на SM100/SM103. На blockwise-FP8-модели это не «медленнее» и не «откат», а `ValueError` на старте. Задавать его имеет смысл лишь чтобы зафиксировать выбор, который `auto` на подходящей карте и так сделает.
- Значение вне списка отвергает argparse; значение из списка на неподходящем железе — `RuntimeError` при инициализации планировщика.

## Когда использовать

- Задавайте явно, когда сравниваете ядра на своей нагрузке или воспроизводите чужой замер: на Hopper реальный выбор — `deep_gemm` против `flashinfer_deepgemm` (декод) и против `triton` (совместимость).
- Задавайте `triton`, если DeepGEMM JIT падает или его компиляция неприемлемо долгая на вашем окружении.
- Не задавайте на неквантованной модели: FP8-путь там просто не строится, флаг мертв.
- Не переносите значение между поколениями карт — это гарантированный `RuntimeError` на старте.

## Влияние на производительность и память

- **Throughput/latency плотных слоев** — основной эффект. Разница между Triton-fallback и DeepGEMM/TRT-LLM на FP8 существенная, особенно на длинном prefill.
- **Время старта.** `deep_gemm` — JIT-компиляция ядер перед первым проходом; `flashinfer_*` может дополнительно потянуть за собой прогон автотюнинга (`--disable-flashinfer-autotune`).
- **VRAM.** Прямого эффекта почти нет; разные ядра требуют разной раскладки масштабов (`flashinfer_cutlass` транспонирует scale-тензоры под `scale_major_mode="MN"`), что дает небольшие временные буферы на forward.
- **Точность.** Не меняется: формат весов и масштабов задан чекпоинтом, backend только считает.

## Взаимодействие с другими аргументами

- `--quantization`: определяет, существует ли FP8-путь вообще; `mxfp8` переводит флаг в узкую роль (учитывается только `flashinfer_trtllm`/`deep_gemm`).
- `--fp4-gemm-backend`, `--bf16-gemm-backend`: соседние аргументы для других форматов, инициализируются рядом в `scheduler.py`.
- `--moe-runner-backend`: экспертные GEMM выбираются отдельно; названия значений похожи, но это разные реестры.
- `--disable-flashinfer-autotune` / `--flashinfer-autotune-skip-ops`: влияют на то, будут ли FlashInfer-ядра оттюнены.
- `--dtype`: `flashinfer_trtllm` на не-bf16 входе уходит в Triton на forward.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: DeepGEMM backend requested via --fp8-gemm-backend=deep_gemm, but DeepGEMM is not available.` **Причина:** пакет не установлен или `SGLANG_ENABLE_JIT_DEEPGEMM=0`. **Решение:** `auto` или `triton`.
- **Симптом:** `--fp8-gemm-backend=cutlass is deprecated on this hardware.` **Причина:** SM90/SM100 вместо SM120.
- **Симптом:** `ValueError: Unknown FP8 GEMM backend: Fp8GemmRunnerBackend.FLASHINFER_CUTEDSL` (или похожее на другом значении). **Причина:** значение допустимо для argparse, но у него нет ветки в `_dispatch_explicit_backend` — то есть оно не про blockwise-FP8. **Решение:** `flashinfer_cutedsl` применим только к MXFP8-плотным слоям; для blockwise-FP8 берите `auto`, `deep_gemm` или `flashinfer_trtllm`.
- **Симптом:** `MXFP8 dense GEMM requested via --fp8-gemm-backend=flashinfer_cutedsl, but that kernel requires an SM100/SM103 GPU and FlashInfer.` **Причина:** карта не Blackwell нужного поколения, нет FlashInfer или FlashInfer не подтверждает поддержку `cute-dsl` для этого SM. **Решение:** `auto` — он сам откатится на `flashinfer_cutlass`.
- **Симптом:** `No MXFP8 dense GEMM kernel is available on this device.` **Причина:** MXFP8-модель на карте без подходящего ядра; выбор backend'а здесь не спасает.
- **Симптом:** значение задано, а производительность не изменилась. **Причина:** модель не FP8-квантована, либо основная нагрузка приходится на MoE-эксперты (там работает `--moe-runner-backend`).
- **Проверка:** дамп `server_args=` при старте показывает заданное значение поля `fp8_gemm_runner_backend`; фактическое разрешение `auto` в дампе не видно и определяется наличием DeepGEMM и поколением карты.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --quantization fp8 --fp8-gemm-backend deep_gemm
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --quantization fp8 --fp8-gemm-backend triton --disable-flashinfer-autotune
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/quantization/fp8_utils.py`
- `sglang/python/sglang/srt/layers/quantization/fp8.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
- `sglang/docs/docs/advanced_features/quantization.mdx`
