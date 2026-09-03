---
schema: 1
engine: sglang
primaryName: "--speculative-moe-runner-backend"
title: "--speculative-moe-runner-backend"
summary: Отдельное вычислительное ядро grouped GEMM для MoE-слоёв draft-модели. Если не задан, наследует уже разрешённое значение `--moe-runner-backend` target-модели; в отличие от него не проходит ни одной проверки совместимости с квантизацией и `--ep-size`.
group: spec
related:
  - --moe-runner-backend
  - --speculative-moe-a2a-backend
  - --speculative-algorithm
  - --speculative-draft-model-quantization
  - --quantization
  - --ep-size
---

# --speculative-moe-runner-backend

## Кратко

`--speculative-moe-runner-backend` — тот же выбор ядра grouped GEMM, что и `--moe-runner-backend`, но применяемый только на время сборки и прогонов MoE-слоёв черновика. Он нужен потому, что MTP/draft-слой обычно не квантизован так же, как target-модель: ядро, оптимальное для FP8-весов target-модели, для одного bf16-слоя черновика может быть неприменимо. Значение по умолчанию — не `auto`, а «унаследовать разрешённое значение target-модели»: подстановка происходит в `__post_init__`, поэтому в дампе `server_args=` пустого значения не бывает.

## Оригинальная справка

```text
Choose the runner backend for MoE in speculative decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-moe-runner-backend`
- Группа: `spec`
- Тип значения: строка с фиксированным списком (`MOE_RUNNER_BACKEND_CHOICES`, тот же, что у `--moe-runner-backend`)
- Допустимые значения: `auto`, `deep_gemm`, `triton`, `triton_kernel`, `flashinfer_trtllm`, `experimental_sgl_trtllm`, `flashinfer_trtllm_routed`, `flashinfer_cutlass`, `flashinfer_mxfp4`, `flashinfer_cutedsl`, `cutlass`, `aiter`, `marlin`, `humming`, `experimental_sgl_marlin`, `hpc_ops`, `megamoe`. Список расширяем сторонними платформенными пакетами через `add_moe_runner_backend_choices`, поэтому итоговый набор смотрите в `--help` установленной сборки
- Значение по умолчанию: `null`
- Эффективное значение: `_speculative_moe_runner_default` (`sglang/python/sglang/srt/arg_groups/overrides.py`) при `null` копирует **разрешённое** `moe_runner_backend` target-модели; для DeepSeek-семейства с `modelopt_fp4` на ROCm `_deepseek_spec_moe_resolution` может выставить `deep_gemm` (вместе с a2a `deepep`) или `triton`
- Где объявлен: `ServerArgs.speculative_moe_runner_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подстановка значения по умолчанию) → `initialize_moe_config` при инициализации model runner → сборка и прогоны MoE-слоёв черновика внутри `speculative_moe_backend_context()`

## Что меняет в движке

Порядок в `__post_init__` важен: сначала выполняются `_handle_moe_kernel_config` и `_handle_a2a_moe` — они разрешают и проверяют `--moe-runner-backend` target-модели, — и только потом вызывается `handle_speculative_decoding`, который первым делом прогоняет `_speculative_moe_runner_default`. Поэтому наследуется не то, что вы написали в `--moe-runner-backend`, а то, во что движок его превратил.

Дальше `initialize_moe_config` (`sglang/python/sglang/srt/layers/moe/utils.py`) кладёт значение в `moe.speculative_runner_backend`. Читается оно только внутри контекст-менеджера `speculative_moe_backend_context()`, который на время подменяет активный `moe.runner_backend`. Этим контекстом обёрнуты в EAGLE-, multi-layer-EAGLE-, frozen-KV-MTP- и standalone-воркерах: построение draft-модели (`draft_model_build_scope`), инициализация attention-бэкендов, захват CUDA graph и сами forward'ы черновика. Как только контекст закрывается, возвращается ядро target-модели.

Значение `auto` здесь означает ровно то же, что и для target-модели: решение принимает quant-метод конкретного слоя в `create_moe_runner`, а не централизованная логика.

Отдельно: `should_run_flashinfer_autotune(..., for_speculative_draft=True)` и `cuda_graph_setup` читают пару «спекулятивный runner + спекулятивный a2a» напрямую из `server_args`, чтобы решить, нужен ли автотюнинг FlashInfer и режим графов для draft-воркера.

## Значения и формат

- Не задан — наследование разрешённого значения target-модели. Это и есть рекомендуемый режим.
- `auto` — явно попросить quant-метод draft-слоя выбрать ядро самостоятельно. Отличается от «не задан» тем, что не наследует уже принятое решение target-модели.
- Значение вне списка отвергает argparse. Значение из списка, но несовместимое с форматом весов черновика или с железом, здесь **не** проверяется: все ассерты `_handle_moe_kernel_config` (ограничения `flashinfer_cutlass`/`flashinfer_cutedsl` на `--ep-size`, требования `hpc_ops` к SM90 и FP8, правила для `mxfp8`/`nvfp4_online`) читают только `moe_runner_backend`. Отказ придёт позже — из сборки draft-модели.
- `megamoe` здесь — нерабочая механическая добавка общего choices-списка: alias-перевод в `--moe-a2a-backend megamoe` существует только для `--moe-runner-backend`. Здесь строка доходит до `MoeRunnerBackend("megamoe")` и завершает старт с `ValueError`; не используйте её для draft-модели.

## Когда использовать

- Когда target-модель квантизована, а MTP/draft-слой — нет: наследованное ядро может требовать формата весов, которого у черновика нет. Типовой ответ — `triton`.
- Когда для target-модели выбрано ядро с дорогой подготовкой весов или JIT-компиляцией, а черновик — один-два слоя: дешевле явно поставить `triton` и не платить компиляцией дважды.
- Когда воспроизводите конфигурацию из апстрим-бенчмарка, где спекулятивное ядро указано отдельно.
- Не задавать, если MoE в черновике нет вообще (плотная draft-модель, NGRAM, DFLASH без MoE-слоёв) — аргумент просто не будет прочитан.
- Не подбирать «на глаз»: у этого флага нет предстартовых проверок, которые поймали бы ошибку.

## Влияние на производительность и память

- VRAM: косвенно. Разные раннеры по-разному перепаковывают веса в `process_weights_after_loading` и по-разному аллоцируют рабочие буферы; для одного-двух draft-слоёв разница мала, но не нулевая.
- Время старта: JIT-пути (DeepGEMM, Triton без прогретого кеша) добавляют компиляцию отдельно для черновика — контекст сборки черновика отличается от target-модели.
- Throughput/latency: эффект пропорционален доле времени, которую занимают MoE-слои черновика. Черновик прогоняется `--speculative-num-steps` раз за decode-шаг, поэтому неудачный выбор ядра умножается на глубину спекуляции.
- RAM хоста: не влияет.

## Взаимодействие с другими аргументами

- `--moe-runner-backend`: источник значения по умолчанию — но именно разрешённого, после всех переопределений по модели, квантизации и железу.
- `--speculative-moe-a2a-backend`: парный аргумент. Обратите внимание на асимметрию: runner получает значение по умолчанию ещё в `__post_init__`, а a2a остаётся `None` в `server_args` и подставляется только в `initialize_moe_config`.
- `--speculative-draft-model-quantization`: определяет формат весов черновика, а значит и применимость выбранного ядра. Значение `unquant` (черновик без квантизации при квантизованной target-модели) — самый частый повод задать этот флаг вручную.
- `--quantization` и `--ep-size`: ограничивают ядро target-модели; на спекулятивное ядро эти проверки не распространяются, хотя железо и формат весов у него те же.
- `--speculative-algorithm`: аргумент имеет смысл только там, где есть draft-модель с MoE-слоями (EAGLE-семейство, MTP, STANDALONE).

## Типовые проблемы и диагностика

- Падение внутри сборки draft-модели с сообщением quant-метода про неподдерживаемый формат (`Invalid quantization …`, `only supports Fp8MoEMethod …`) — ядро несовместимо с весами черновика. Уберите явное значение или поставьте `triton`.
- Долгий старт с двумя раундами JIT-компиляции — target-модель и черновик используют разные JIT-пути; сведите их к одному ядру.
- Значение «не применилось» — проверьте, что у черновика вообще есть MoE-слои: без них контекст `speculative_moe_backend_context()` ничего не меняет.
- Чем подтвердить: дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — там уже подставленное значение; для ROCm-ветки DeepSeek дополнительно ищите `Use deep_gemm moe runner and deepep a2a backend for bf16 nextn layer in deepseek fp4 checkpoint.` или `Use triton fused moe by default for bf16 nextn layer in deepseek fp4 checkpoint.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm NEXTN --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --tp-size 8 --ep-size 8 --moe-runner-backend deep_gemm --speculative-moe-runner-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --speculative-algorithm EAGLE --speculative-draft-model-path /models/qwen3-moe-eagle --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --speculative-moe-runner-backend triton --speculative-moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/standalone_worker_v2.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
