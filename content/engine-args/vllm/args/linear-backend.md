---
schema: 1
engine: vllm
primaryName: "--linear-backend"
title: "--linear-backend"
summary: Ограничивает выбор ядра GEMM для квантованных linear-слоёв одним семейством. Работает как фильтр по списку ядер: если для типа слоя подходящего ядра нет, движок в большинстве путей предупреждает и откатывается к обычному выбору.
group: KernelConfig
related:
  - --moe-backend
  - --kernel-config
  - --quantization
  - --dtype
  - --enable-flashinfer-autotune
  - --ir-op-priority
---

# --linear-backend

## Кратко

Для каждого квантованного linear-слоя vLLM держит список ядер в порядке предпочтения и берёт первое, у которого `is_supported()` и `can_implement(config)` дают «да». `--linear-backend` вставляет перед этим перебором фильтр: остаются только ядра выбранного семейства.

Это ручка сравнительных замеров и обхода багов в конкретном ядре, а не «ускоритель». Большинство значений жёстко привязано к железу (`aiter` — только ROCm, `xpu`/`xpu_woq` — только XPU, `flashinfer_b12x` и `b12x` — только SM120/SM121), а `emulation` в справке прямо помечен как «for testing only».

## Оригинальная справка

```text
Backend for quantized linear layer GEMM kernels. Available options:

- "auto": Automatically select the best backend based on model and hardware
- "cutlass": Use CUTLASS-based kernels
- "flashinfer_cutlass": Use FlashInfer with CUTLASS kernels
- "flashinfer_cutedsl": Use FlashInfer with CuTe-DSL kernels (NVFP4, MXFP8)
- "flashinfer_trtllm": Use FlashInfer with TensorRT-LLM kernels
- "flashinfer_cudnn": Use FlashInfer with cuDNN kernels
- "flashinfer_b12x": Use FlashInfer b12x CuteDSL NVFP4 GEMM (SM120+)
- "b12x": Use native B12X FP8 and FP4 linear kernels on SM12x
- "marlin": Use Marlin kernels
- "triton": Use Triton-based kernels
- "deep_gemm": Use DeepGEMM kernels
- "torch": Use PyTorch native scaled_mm kernels
- "aiter": Use AMD AITer kernels (ROCm only)
- "machete": Use Machete kernels (mixed-precision)
- "fbgemm": Use FBGEMM kernels
- "conch": Use Conch mixed-precision kernels
- "exllama": Use Exllama mixed-precision kernels
- "emulation": Use slow dequant-to-BF16 emulation (for testing only)
- "xpu": Use XPU kernels
- "xpu_woq": Use XPU kernels for weight-only quantization (e.g. W8A16)
```

## Паспорт аргумента

- Флаги: `--linear-backend`
- Группа argparse: `KernelConfig`
- Тип значения: строка из фиксированного набора (`Literal`), argparse проверяет по `choices`
- Допустимые значения: `auto`, `cutlass`, `flashinfer_cutlass`, `flashinfer_cutedsl`, `flashinfer_trtllm`, `flashinfer_cudnn`, `flashinfer_b12x`, `b12x`, `marlin`, `humming`, `triton`, `deep_gemm`, `torch`, `aiter`, `machete`, `fbgemm`, `conch`, `exllama`, `emulation`, `xpu`, `xpu_woq`. Обратите внимание: `humming` есть в `choices` и в `_LINEAR_BACKEND_KERNEL_MAP`, но в тексте справки не перечислен
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` означает «фильтра нет». Явное значение может быть перебито переменной окружения `VLLM_BATCH_INVARIANT=1` для NVFP4-слоёв — там принудительно берётся CUTLASS (или emulation), о чём пишется `VLLM_BATCH_INVARIANT overrides --linear-backend=%s`
- Где объявлен: `vllm/config/kernel.py:KernelConfig.linear_backend`
- Этап применения: загрузка модели — конструирование каждого квантованного linear-слоя

## Что меняет в движке

`_LINEAR_BACKEND_KERNEL_MAP` (`vllm/model_executor/kernels/linear/__init__.py`) сопоставляет каждому значению множество классов ядер. Функция `_filter_kernels_by_backend()` оставляет из платформенного списка-приоритета только их, а `_resolve_backend_kernels()` применяет фильтр в пяти точках выбора: `scaled-mm` (int8/fp8), `mixed-precision`, `MXFP8`, `MXFP4`, `NVFP4`.

Ключевая деталь поведения при промахе: `_resolve_backend_kernels()` **не падает**, а логирует

```
--linear-backend=%s was requested, but no %s kernel exists for %s layers;
falling back to normal kernel selection for this layer.
```

и возвращает нефильтрованный список. Мотивация в коде названа прямо: явно выбранный backend обычно закрывает одну схему квантизации, а модель содержит слои нескольких типов (NVFP4-проекции MoE рядом с FP8-проекциями внимания). То есть флаг фильтрует там, где может, и молча уступает там, где не может.

Исключение из этого правила одно: `init_mxfp6_linear_kernel()` при пустом результате фильтрации поднимает `ValueError: --linear-backend=X was requested but no 'X' kernel exists for MXFP6 layers.`

Если после фильтрации кандидаты есть, но ни один не проходит `is_supported()`/`can_implement()`, старт падает с перечислением причин: `Failed to find a kernel that can implement the ScaledMM linear layer. Reasons: ...` (и аналогично для MXFP4/NVFP4/MXFP6). Отдельно каждое ядро можно вычеркнуть переменной `VLLM_DISABLED_KERNELS`.

Ещё одно место, где значение читается напрямую, — `compressed_tensors.py`: `linear_backend in ("xpu", "torch")` меняет ветку подготовки весов.

## Значения и формат

- Значение нормализуется перед проверкой: `type=lambda s: s.lower().replace("-", "_")`, поэтому `FlashInfer-CUTLASS` и `flashinfer_cutlass` эквивалентны. Значение вне списка отвергает сам argparse (`invalid choice`).
- `auto` — не «выбрать лучшее из фильтра», а «фильтра нет»: `create_engine_config` копирует значение в `KernelConfig` только при `!= "auto"`.
- Платформенные значения на чужой платформе не запрещены парсером: `--linear-backend aiter` на CUDA пройдёт разбор, но ни одного AITer-ядра в списке CUDA не окажется, и вы получите предупреждение об откате на каждом типе слоя.
- `emulation` разворачивает веса в BF16 и гоняет QDQ по активациям — это диагностический эталон численности, а не рабочий режим.
- `b12x` и `flashinfer_b12x` — разные вещи, несмотря на общее имя. `b12x` — нативные ядра из отдельного опционального PyPI-пакета `b12x` (`uv pip install "vllm[b12x]"`): пять классов, закрывающих per-tensor FP8, блочный FP8 128×128, MXFP8, NVFP4 и MXFP4; W4A16 они не покрывают — такие слои остаются за Marlin. `flashinfer_b12x` — одно ядро `FlashInferB12xNvFp4LinearKernel` (только NVFP4) из библиотеки FlashInfer. Оба требуют CUDA-устройство семейства capability 120 (SM120/SM121, потребительский и workstation Blackwell); без пакета `b12x` его ядра честно отваливаются на `is_supported()` с текстом ``Install the B12X backend with `pip install vllm[b12x]` ``. В автоматическом выборе (`auto`) ядра `b12x` стоят после устоявшихся backend'ов (Marlin/FlashInfer/CUTLASS) и перед emulation, а `FlashInferB12xNvFp4LinearKernel` в NVFP4-списке приоритетнее нативного `B12xNvFp4LinearKernel`.
- Структурная форма: `--kernel-config '{"linear_backend": "marlin"}'`. Алиаса `-kc` у `--kernel-config` нет.
- На неквантованной модели аргумент бесполезен: фильтруются только пути квантованных linear-слоёв.

## Когда использовать

- **Подозрение на баг в ядре.** Численный мусор или падение внутри конкретного GEMM: переключение на `triton` или `torch` даёт медленный, но предсказуемый эталон, и сразу отвечает на вопрос «ядро или модель».
- **Сравнительный замер на своей карте.** Marlin против CUTLASS против FlashInfer на конкретной квантизации и конкретных размерах — приоритетный список апстрима не всегда оптимален для узкой матрицы.
- **Проверка численности.** `emulation` даёт BF16-эталон, с которым можно сравнить вывод рабочего ядра.
- **Не задавайте в проде без замера.** Фильтр сужает выбор, а не улучшает его; на слоях, которых backend не покрывает, вы получаете шум в логах и прежнее поведение.
- **Не используйте как способ включить FlashInfer.** Если библиотека не установлена, ядра просто не пройдут `is_supported()`, и вы упрётесь либо в откат, либо в отказ.

## Влияние на производительность и память

- **Throughput и latency.** Это и есть точка приложения: ядра одного и того же слоя отличаются в разы, особенно на малых batch. `emulation` медленнее всех и требует дополнительной памяти под разворачивание весов.
- **VRAM.** Ядра различаются рабочими буферами и требованиями к раскладке весов (Marlin, Machete, AITer переупаковывают веса). Разница попадает в профилирование как не-KV память и косвенно меняет размер KV-cache.
- **Время старта.** Ядра с JIT (Triton, CuTe-DSL, DeepGEMM) компилируются при первом использовании либо в прогреве; смена семейства меняет и состав прогрева. У `b12x` прогрев собственный (`b12x_warmup` в `kernel_warmup.py`): JIT-сигнатуры компилируются на старте для набора размеров батча — 1, размеры CUDA graph capture и `max_num_batched_tokens`, с отчетом `Warmed up N B12X <вид> linear GEMM signatures.` в логе.
- **Численность.** Разные ядра — разный порядок накопления, поэтому побитовой воспроизводимости между семействами нет. Детерминизм даёт `VLLM_BATCH_INVARIANT=1`, и он перебивает этот флаг.

## Взаимодействие с другими аргументами

- `--moe-backend`: соседняя ручка для MoE-экспертов, из той же `KernelConfig`. Разделение строгое: этот флаг не влияет на fused-MoE, тот не влияет на плотные linear-слои. Но ведут они себя по-разному — MoE-оракул при неподходящем значении **падает**, а linear в большинстве путей откатывается.
- `--kernel-config`: та же настройка в JSON-форме.
- `--quantization` и формат весов модели: определяют, какая из пяти точек выбора вообще задействована. Backend, покрывающий чужую схему, окажется бесполезным фильтром.
- `--dtype`: часть ядер требует конкретных типов активаций/выхода; несоответствие видно в причинах `can_implement`.
- `--enable-flashinfer-autotune`: имеет смысл только если действительно выбраны FlashInfer-ядра. Автотюнинг пропускает `fp4_gemm`, когда выбран `FlashInferCuteDslNvFp4LinearKernel`.
- `--ir-op-priority`: соседний, но независимый механизм — он выбирает провайдера для IR-операций (rms_norm и подобных), а не GEMM-ядро linear-слоя.

## Типовые проблемы и диагностика

- **Симптом:** `--linear-backend=marlin was requested, but no marlin kernel exists for NVFP4 layers; falling back to normal kernel selection for this layer.` **Причина:** штатный откат — у семейства нет ядра для этого типа слоя. **Лечение:** ничего, если так и задумано; иначе выбрать семейство, покрывающее нужную схему.
- **Симптом:** `ValueError: Failed to find a kernel that can implement the ScaledMM linear layer. Reasons: ...` **Причина:** после фильтрации кандидаты остались, но ни один не поддерживается на этой карте/в этой сборке. **Проверка:** причины перечислены построчно по каждому ядру. **Лечение:** `auto` либо другое семейство.
- **Симптом:** `--linear-backend=X was requested but no 'X' kernel exists for MXFP6 layers.` **Причина:** единственный путь с жёстким отказом вместо отката. **Лечение:** снять флаг для MXFP6-модели.
- **Симптом:** флаг задан, а в логе выбраны ядра другого семейства без предупреждения. **Причина:** либо значение `auto`, либо `VLLM_BATCH_INVARIANT=1` (тогда рядом лежит строка `VLLM_BATCH_INVARIANT overrides --linear-backend=...`).
- **Симптом:** просадка производительности после смены backend'а. **Проверка:** строки `Using <KernelClass> for FP8 GEMM` / `for MXFP4 GEMM` / `for NVFP4 GEMM` / `Selected <KernelClass> for <module>` показывают итоговое ядро на каждый тип слоя. **Лечение:** вернуть `auto`.
- **Подтверждение принятого значения:** именно эти `Using ... GEMM`-строки; отдельной строки «linear backend = X» движок не печатает.

## Примеры

```bash
vllm serve /models/Qwen3-4B-FP8 --linear-backend triton --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B-FP8 --kernel-config '{"linear_backend": "cutlass"}' --max-model-len 8192
```

## Источники

- `vllm/vllm/config/kernel.py`
- `vllm/vllm/model_executor/kernels/linear/__init__.py`
- `vllm/vllm/model_executor/layers/quantization/compressed_tensors/compressed_tensors.py`
- `vllm/vllm/model_executor/warmup/kernel_warmup.py`
- `vllm/vllm/model_executor/warmup/b12x_warmup.py`
- `vllm/vllm/utils/b12x.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/docs/features/quantization/b12x.md`
- коммит checkout'а `3c79b1a8bf` «[Kernel] Add B12X dense linear backends (#52016)» — добавил значение `b12x` и пять нативных ядер
