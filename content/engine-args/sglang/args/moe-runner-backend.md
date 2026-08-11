---
schema: 1
engine: sglang
primaryName: "--moe-runner-backend"
title: "--moe-runner-backend"
summary: Выбирает вычислительное ядро для grouped GEMM экспертов MoE. Значение `auto` разрешается не централизованно, а внутри метода квантизации слоя, поэтому явное значение часто конфликтует с форматом весов и железом.
group: exec.moe
related:
  - --moe-a2a-backend
  - --quantization
  - --speculative-moe-runner-backend
  - --deepep-mode
  - --ep-size
---

# --moe-runner-backend

## Кратко

`--moe-runner-backend` задает, какое ядро считает эксперты после dispatch: Triton, DeepGEMM, CUTLASS, разные варианты FlashInfer и другие. По умолчанию `auto`, и это не «одно значение, которое движок подставит», а отложенное решение: каждый quant-метод сам выбирает раннер под свой формат весов и железо. Явное значение, наоборот, жестко проверяется ассертами на совместимость с `--quantization`, `--ep-size` и `--moe-a2a-backend` — несовместимая пара падает на старте, а не деградирует.

## Оригинальная справка

```text
Choose the runner backend for MoE.
```

## Паспорт аргумента

- Флаги: `--moe-runner-backend`
- Группа: `exec.moe`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `auto`, `deep_gemm`, `triton`, `triton_kernel`, `flashinfer_trtllm`, `experimental_sgl_trtllm`, `flashinfer_trtllm_routed`, `flashinfer_cutlass`, `flashinfer_mxfp4`, `flashinfer_cutedsl`, `cutlass`, `aiter`, `marlin`, `humming`, `experimental_sgl_marlin`, `hpc_ops`, `megamoe`. Список — константа `MOE_RUNNER_BACKEND_CHOICES` в `sglang/python/sglang/srt/server_args.py`; функция `add_moe_runner_backend_choices` позволяет сторонним платформенным пакетам расширить его, поэтому итоговый набор проверяйте по `--help` установленной сборки
- Значение по умолчанию: `auto`
- Эффективное значение: переопределяется в нескольких местах — `ServerArgs._handle_moe_runner_backend_alias` (`megamoe`), `_moe_runner_backend_quant_constraints` (правила по `--quantization`), `_cutlass_moe_env_override` (устаревшая переменная `SGLANG_CUTLASS_MOE`), `_handle_a2a_moe` (для `pplx`) и, наконец, сам quant-метод слоя при `auto`
- Где объявлен: `ServerArgs.moe_runner_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (нормализация и проверки) → `initialize_moe_config` при инициализации model runner → создание `MoeRunner` для каждого MoE-слоя

## Что меняет в движке

Значение публикуется через `initialize_moe_config` (`sglang/python/sglang/srt/layers/moe/utils.py`) как `MoeRunnerBackend` и читается повсеместно через `get_moe_runner_backend()`. Конкретный `MoeRunner` создает quant-метод слоя в `create_moe_runner`, и именно там `auto` превращается в реальное ядро. Примеры из checkout'а:

- `Fp8MoEMethod.create_moe_runner`: `auto` → `deep_gemm`, если применим DeepGEMM-путь (он требует, чтобы `--moe-a2a-backend` был `deepep`, `mooncake` или `nixl`, и чтобы JIT DeepGEMM был включен), иначе на ROCm → `aiter`, иначе → `triton`.
- `UnquantizedFusedMoEMethod`: `ascend` на NPU, иначе `triton`; на ROCm при `auto`/`aiter` дополнительно готовится AITER-раннер, если форма весов выровнена по 128.
- Значение `ascend` не является CLI-значением: раннер Ascend выбирается только из `auto`, и документация SGLang прямо пишет, что на Ascend NPU `--moe-runner-backend` настраивать не нужно.

Правила по квантизации применяются раньше, в `_moe_runner_backend_quant_constraints` (`sglang/python/sglang/srt/arg_groups/overrides.py`):

- `--quantization nvfp4_online`: `auto` → `flashinfer_trtllm`; любое другое значение, кроме `flashinfer_trtllm`/`flashinfer_trtllm_routed`, — `ValueError`;
- `--quantization mxfp8` вне NPU: разрешены только `cutlass`, `deep_gemm`, `flashinfer_trtllm`, `flashinfer_trtllm_routed` (плюс `triton` на gfx95); прочее заменяется на дефолт с предупреждением в логе;
- `auto` + `modelopt_fp4` + SM120: → `flashinfer_cutlass` (ядра trtllm-gen существуют только для SM100).

Дальше `_handle_moe_kernel_config` добавляет жесткие проверки совместимости: `flashinfer_cutlass` и `flashinfer_cutedsl` требуют `ep_size ∈ {1, tp_size}` и своего набора значений `--quantization`; `flashinfer_cutedsl` дополнительно ограничивает `--moe-a2a-backend` значениями `none`/`deepep`/`flashinfer`; `cutlass` с `fp8`/`mxfp8` требует `ep_size == 1`; `hpc_ops` требует SM90 и FP8-метода квантизации и падает с подробным сообщением при несоблюдении.

Отдельно раннер влияет на fused shared experts: `flashinfer_cutedsl`, `flashinfer_trtllm`, `experimental_sgl_trtllm` и `flashinfer_trtllm_routed` принудительно выставляют `disable_shared_experts_fusion`.

## Значения и формат

- `auto` — рекомендуемое значение. Оно означает «пусть решит quant-метод», а не «выбери самое быстрое».
- `megamoe` — не раннер, а псевдоним: `_handle_moe_runner_backend_alias` (первый обработчик в `__post_init__`) превращает его в `--moe-runner-backend auto --moe-a2a-backend megamoe`, а если `--moe-a2a-backend` уже задан другим значением, перетирает его с предупреждением в логе.
- `experimental_sgl_trtllm` и `experimental_sgl_marlin` — экспериментальные варианты, разделяющие подготовку весов с `flashinfer_trtllm` и `marlin` соответственно; контракт может меняться.
- `hpc_ops` — только SM90 (Hopper) и только FP8 blockwise/per-tensor.
- Устаревшая переменная окружения `SGLANG_CUTLASS_MOE` продолжает работать и перетирает значение на `cutlass`, печатая рекомендацию использовать этот флаг вместо нее.
- Значение вне списка отвергает argparse; значение из списка, но неподдерживаемое вашим железом или форматом весов, отвергается ассертом уже после разбора.

## Когда использовать

- Оставляйте `auto`, пока нет измеренной причины сменить раннер: автоподбор учитывает архитектуру GPU, формат весов и наличие JIT-компилируемых ядер.
- Задавайте явно, когда: воспроизводите конфигурацию из документации/бенчмарка; отлаживаете подозрение на конкретное ядро; используете квантизацию, у которой несколько допустимых раннеров с разной производительностью (например FP8 на Hopper — `deep_gemm` против `triton`).
- Для `triton` имеет смысл заранее подготовить тюненые конфигурации ядер — апстрим-документация SGLang прямо на это указывает.
- Не подбирайте раннер «на глаз» под чужую модель: раннер валиден в связке с конкретным `--quantization`.

## Влияние на производительность и память

- На VRAM влияет косвенно: разные раннеры по-разному раскладывают веса (`process_weights_after_loading` может перепаковывать тензоры под layout ядра) и по-разному аллоцируют рабочие буферы.
- На время старта влияет заметно: JIT-компилируемые пути (DeepGEMM, Triton без готового кеша) добавляют компиляцию перед первым проходом.
- На throughput/latency — это и есть основной эффект: выбор ядра определяет производительность grouped GEMM экспертов, то есть самой тяжелой части MoE-слоя.
- Косвенный расход VRAM возможен через принудительное отключение shared-experts fusion у FlashInfer-раннеров.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: `megamoe` связывает их напрямую; `flashinfer_cutedsl` ограничивает набор a2a; `pplx` требует `deep_gemm` (или `auto`, который в него и разрешается); DeepGEMM-путь FP8 при `auto` включается только с a2a из семейства DeepEP.
- `--quantization`: главный ограничитель, см. выше.
- `--ep-size`: `flashinfer_cutlass`/`flashinfer_cutedsl` требуют `1` или `tp_size`; `cutlass` с FP8/MXFP8 — строго `1`.
- `--speculative-moe-runner-backend`: если не задан, наследует **разрешенное** значение целевой модели (`_speculative_moe_runner_default`).
- `--deepep-mode`: при `flashinfer_cutedsl` + DeepEP режим `normal` запрещен, а `auto` принудительно превращается в `low_latency`.
- `--disable-shared-experts-fusion`: у части раннеров выставляется автоматически.

## Типовые проблемы и диагностика

- `Invalid quantization '<x>'. FlashInfer … MOE supports only: …` — раннер несовместим с форматом весов; уберите явное значение или смените квантизацию.
- `The expert parallel size must be 1 or the same as the tensor parallel size` — нарушено ограничение `flashinfer_cutlass`/`flashinfer_cutedsl` на `--ep-size`.
- `--moe-runner-backend hpc_ops only supports Fp8MoEMethod …` или `requires an SM90 (Hopper) GPU` — раннер выбран для неподходящей модели/карты.
- `mxfp8 quantization supports only …. Overriding '<x>'` — предупреждение, а не ошибка: значение молча заменено. Проверяйте лог, если ожидали другое ядро.
- `SGLANG_CUTLASS_MOE is deprecated …` — раннер перетерт переменной окружения.
- Что реально выбрано, видно по дампу `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — там уже разрешенное значение — и по информационной строке о deferred finalize в `fused_moe_triton/layer.py`, которая печатает `moe_runner_backend=` и имя quant-метода.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --moe-a2a-backend deepep --moe-runner-backend deep_gemm --tp-size 8 --ep-size 8
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --moe-runner-backend triton --moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/layers/moe/moe_runner/runner.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/layers/quantization/fp8.py`
- `sglang/python/sglang/srt/layers/quantization/unquant.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
