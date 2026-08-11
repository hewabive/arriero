---
schema: 1
engine: vllm
primaryName: "--moe-backend"
title: "--moe-backend"
summary: Принудительно выбирает семейство ядер для вычисления экспертов MoE вместо автоподбора «оракулом» по схеме квантизации и железу. В отличие от `--linear-backend`, неподходящее значение приводит к отказу на старте, а не к откату.
group: KernelConfig
related:
  - --linear-backend
  - --kernel-config
  - --quantization
  - --enable-expert-parallel
  - --all2all-backend
  - --enable-eplb
  - --max-num-batched-tokens
  - --enable-bf16x3-router-gemm
  - --enable-flashinfer-autotune
---

# --moe-backend

## Кратко

У MoE-слоя ядро подбирается «оракулом»: для каждой схемы квантизации (`unquantized`, `fp8`, `int8`, `int_wna16`, `mxfp4`, `mxfp8`, `nvfp4`, `w4a8`, `w4a8_int8`) есть свой модуль в `vllm/model_executor/layers/fused_moe/oracle/`, свой приоритетный список кандидатов и своя проверка `is_supported_config`.

`--moe-backend` подменяет перебор: имя транслируется в конкретный backend этой схемы и проверяется один раз. Не поддерживается — `ValueError` на старте. Никакого тихого отката, в отличие от `--linear-backend`.

## Оригинальная справка

```text
Backend for MoE expert computation kernels. Available options:

- "auto": Automatically select the best backend based on model and hardware
- "triton": Use Triton-based fused MoE kernels
- "batched_triton": Use batched Triton experts (moe_mmk) on the batched
  activation format ([E_local, max_num_tokens, K])
- "deep_gemm": Use DeepGEMM kernels (FP8 block-quantized only)
- "deep_gemm_mega_moe": Use DeepGEMM mega MoE kernels
- "cutlass": Use vLLM CUTLASS kernels
- "flashinfer_trtllm": Use FlashInfer with TRTLLM-GEN kernels
- "flashinfer_cutlass": Use FlashInfer with CUTLASS kernels
- "flashinfer_cutedsl": Use FlashInfer with CuteDSL kernels (FP4 only)
- "flashinfer_b12x": Use FlashInfer CuteDSL fused MoE for SM12x
  (RTX Pro 6000 / DGX Spark)
- "marlin": Use Marlin kernels (weight-only quantization)
- "humming": Use Humming Mixed Precision kernels
- "triton_unfused": Use Triton unfused MoE kernels
- "aiter": Use AMD AITer kernels (ROCm only)
- "flydsl": Use AMD FlyDSL kernels (ROCm only)
- "hpc": Use HPC kernels (FP8 and Hopper only)
- "emulation": use BF16/FP16 GEMM, dequantizing weights and
               running QDQ on activations.
```

## Паспорт аргумента

- Флаги: `--moe-backend`
- Группа argparse: `KernelConfig`
- Тип значения: строка из фиксированного набора (`Literal`), argparse проверяет по `choices`
- Допустимые значения: `auto`, `triton`, `batched_triton`, `deep_gemm`, `deep_gemm_mega_moe`, `cutlass`, `flashinfer_trtllm`, `flashinfer_cutlass`, `flashinfer_cutedsl`, `flashinfer_b12x`, `marlin`, `humming`, `triton_unfused`, `aiter`, `flydsl`, `hpc`, `emulation`. Это **объединение** по всем схемам квантизации: конкретная схема принимает лишь подмножество, и остальные значения она отвергает уже после разбора CLI
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` означает автоподбор. Явное значение почти всегда доходит до оракула без изменений, но при batched-формате активаций (data/expert parallelism) оракул подменяет выбранный backend его batched-вариантом — `TRITON` → `BATCHED_TRITON`, `DEEPGEMM` → `BATCHED_DEEPGEMM`, `VLLM_CUTLASS` → `BATCHED_VLLM_CUTLASS` в FP8-оракуле, `MARLIN` → `BATCHED_MARLIN` в MXFP4. Отдельная поблажка: для неквантованного слоя значение `humming` (квантизационное) не считается ошибкой и проваливается в `auto`
- Где объявлен: `vllm/config/kernel.py:KernelConfig.moe_backend`
- Этап применения: загрузка модели — конструирование `FusedMoEConfig` и выбор класса экспертов в `FusedMoE.__init__`

## Что меняет в движке

Значение копируется в `FusedMoEConfig.moe_backend` (`vllm/model_executor/layers/fused_moe/layer.py`), откуда его читает оракул соответствующей схемы. Логика во всех модулях одинаковая:

1. `map_<схема>_backend(runner_backend)` переводит строку в элемент внутреннего enum. Нет в таблице — `ValueError: moe_backend='X' is not supported for FP8 MoE. Expected one of ['triton', 'deep_gemm', ...]`, и список допустимых для этой схемы печатается прямо в сообщении.
2. `_return_or_raise()` перебирает классы ядер выбранного backend'а и берёт первый, чей `is_supported_config(...)` даёт «да». Успех логируется как `Using <backend> FP8 MoE backend out of potential backends: [...]`. Неудача — `ValueError: MoE backend <backend> does not support the deployment configuration since <причина>`.

При `auto` тот же перебор идёт по всему приоритетному списку схемы, и его состав дополнительно зависит от железа, размерностей и переменных окружения (`VLLM_USE_DEEP_GEMM`, `VLLM_ROCM_USE_AITER`, …).

Отдельно у MXFP4 добавлена проверка формата активаций: значение раскрывается в несколько вариантов (`flashinfer_trtllm` → BF16-акт и MXFP8-акт), и если ни один не совпадает с активацией модели — `ValueError: moe_backend='X' does not support activation=...; supported variants: [...]`.

Ещё две точки, где значение читается напрямую: `all2all_utils` (на XPU `batched_triton` меняет выбор all2all-пути) и `select_unquantized_moe_backend` (batched-формат активаций включается в том числе значением `batched_triton`).

## Значения и формат

- Значение нормализуется: `type=lambda s: s.lower().replace("-", "_")`, поэтому `FlashInfer-TRTLLM` эквивалентно `flashinfer_trtllm`. Значение вне `choices` отвергает argparse.
- `auto` — не «выбрать лучшее», а «оракул работает как обычно»: `create_engine_config` копирует значение в `KernelConfig` только при `!= "auto"`.
- Аппаратно ограниченные значения: `aiter` и `flydsl` — только ROCm, `flashinfer_b12x` — SM12x (RTX Pro 6000 / DGX Spark), `hpc` — FP8 на Hopper, `deep_gemm` — только блочно-квантованный FP8. На чужом железе они проходят разбор CLI, но падают на `is_supported_config`.
- `emulation` разворачивает веса в BF16/FP16 и гоняет QDQ по активациям — эталон численности, а не рабочий режим.
- Внутренние таблицы схем принимают и имена, которых нет в CLI-`choices` (например `flashinfer_trtllm_afp8`, `aiter_mxfp4_fp8`); задать их через CLI нельзя.
- Структурная форма: `--kernel-config '{"moe_backend": "triton"}'`. Алиаса `-kc` у `--kernel-config` нет.
- На модели без MoE-слоёв аргумент не делает ничего.

## Когда использовать

- **Подозрение на баг в fused-MoE ядре.** `triton` (или `triton_unfused`) — самый переносимый вариант и хороший эталон: если проблема ушла, она в специализированном ядре.
- **Сравнительный замер.** На MoE-модели разница между `triton`, `cutlass` и `flashinfer_trtllm` на конкретной карте и конкретном размере батча измеряется тривиально, а приоритетный список апстрима подобран не под вашу конфигурацию.
- **Фиксация профиля.** Автоподбор зависит от установленных пакетов (flashinfer, DeepGEMM) и от переменных окружения; явное значение делает поведение воспроизводимым и падает громко, если окружение поехало.
- **Проверка численности.** `emulation` даёт BF16-эталон для сравнения с квантованным путём.
- **Не задавайте в проде наугад.** Здесь цена ошибки выше, чем у `--linear-backend`: неподходящее значение — это не предупреждение, а несостоявшийся старт.

## Влияние на производительность и память

- **Throughput и latency.** Основная точка приложения. MoE-слой у крупных моделей доминирует по времени шага, и разница между семействами ядер измеряется десятками процентов. `emulation` и `triton_unfused` заметно медленнее специализированных ядер.
- **VRAM.** Ядра различаются рабочими буферами и раскладкой весов; часть требует переупаковки при загрузке. Разница попадает в профилирование как не-KV память и косвенно уменьшает KV-cache. Batched-формат активаций (`batched_triton`) резервирует буфер `[E_local, max_num_tokens, K]`, то есть напрямую зависит от `--max-num-batched-tokens`.
- **Время старта.** Ядра с JIT (Triton, DeepGEMM, CuTe-DSL) компилируются в прогреве; смена семейства меняет состав и длительность прогрева.
- **Численность.** Разные ядра — разный порядок накопления; побитового совпадения между семействами нет.

## Взаимодействие с другими аргументами

- `--linear-backend`: соседняя ручка из той же `KernelConfig` для плотных квантованных linear-слоёв. Не пересекаются по области действия и различаются по поведению при промахе: linear откатывается с предупреждением, MoE падает.
- `--kernel-config`: та же настройка в JSON-форме.
- `--quantization` и формат весов: определяют, какой именно оракул сработает, а значит и какое подмножество значений допустимо.
- `--enable-expert-parallel`, `--all2all-backend`: EP включает batched-формат активаций, из-за которого запрошенный backend подменяется batched-вариантом; на XPU значение `batched_triton` влияет на выбор all2all-пути.
- `--enable-eplb`: перебалансировка экспертов работает поверх выбранного ядра и его не меняет.
- `--max-num-batched-tokens`: задаёт `max_num_tokens` в `FusedMoEConfig`, то есть размер буферов batched-экспертов.
- `--enable-bf16x3-router-gemm`: отдельная ручка для GEMM роутера MoE, а не для ядер экспертов.
- `--enable-flashinfer-autotune`: имеет смысл, если реально выбраны FlashInfer-ядра MoE.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: moe_backend='marlin' is not supported for unquantized MoE. Expected one of ['triton', 'batched_triton', 'flashinfer_trtllm', 'flashinfer_cutlass', 'aiter'].` **Причина:** значение допустимо в CLI, но не для схемы квантизации этой модели. **Лечение:** взять имя из списка в самом сообщении.
- **Симптом:** `ValueError: MoE backend deep_gemm does not support the deployment configuration since <причина>.` **Причина:** схема совпала, но ядро не поддерживает конкретные размерности/железо (у DeepGEMM это только блочно-квантованный FP8). **Лечение:** `auto` или другое семейство.
- **Симптом:** `moe_backend='flashinfer_trtllm' does not support activation=...; supported variants: [...]`. **Причина:** MXFP4-модель, формат активаций не совпал ни с одним вариантом семейства. **Лечение:** выбрать вариант, соответствующий активациям модели, либо `auto`.
- **Симптом:** флаг задан, а в логе видно другое имя backend'а. **Причина:** подстановка batched-варианта при EP/DP (`triton` → `batched_triton` и аналогично). Это ожидаемо.
- **Симптом:** на неквантованной модели `--moe-backend humming` не даёт ошибки и ничего не меняет. **Причина:** явная поблажка в `select_unquantized_moe_backend` — `humming` считается квантизационным и проваливается в `auto`.
- **Подтверждение принятого значения:** строка вида `Using triton Unquantized MoE backend out of potential backends: ['triton', 'flashinfer_cutlass'].` (текст различается по схеме: `FP8 MoE backend`, `MXFP4 MoE backend` и т. д.).

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --moe-backend triton --gpu-memory-utilization 0.9 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-30B-A3B --kernel-config '{"moe_backend": "flashinfer_cutlass"}' --enable-expert-parallel --tensor-parallel-size 2
```

## Источники

- `vllm/vllm/config/kernel.py`
- `vllm/vllm/model_executor/layers/fused_moe/layer.py`
- `vllm/vllm/model_executor/layers/fused_moe/oracle/unquantized.py`
- `vllm/vllm/model_executor/layers/fused_moe/oracle/fp8.py`
- `vllm/vllm/model_executor/layers/fused_moe/oracle/mxfp4.py`
- `vllm/vllm/model_executor/layers/fused_moe/all2all_utils.py`
- `vllm/vllm/engine/arg_utils.py`
