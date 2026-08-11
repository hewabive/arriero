---
schema: 1
engine: sglang
primaryName: "--speculative-moe-a2a-backend"
title: "--speculative-moe-a2a-backend"
summary: Отдельный all-to-all-транспорт экспертов для MoE-слоёв draft-модели. Не задан — на этапе инициализации подставляется значение `--moe-a2a-backend` target-модели; в `server_args=` при этом остаётся `None`.
group: spec
related:
  - --moe-a2a-backend
  - --speculative-moe-runner-backend
  - --moe-runner-backend
  - --speculative-algorithm
  - --ep-size
  - --deepep-mode
  - --enable-dp-attention
---

# --speculative-moe-a2a-backend

## Кратко

`--speculative-moe-a2a-backend` задаёт транспорт dispatch/combine экспертов отдельно для черновика. Нужен там, где target-модель гоняет экспертов через DeepEP или другой a2a, а MTP/draft-слой один и его дешевле считать локально (`none`), либо наоборот. В отличие от парного `--speculative-moe-runner-backend`, значение по умолчанию **не** подставляется в `__post_init__`: поле остаётся `None`, и подмена на значение target-модели происходит только в `initialize_moe_config`. Это надо помнить, читая дамп `server_args=`.

## Оригинальная справка

```text
Choose the backend for MoE A2A in speculative decoding
```

## Паспорт аргумента

- Флаги: `--speculative-moe-a2a-backend`
- Группа: `spec`
- Тип значения: строка с фиксированным списком (`MOE_A2A_BACKEND_CHOICES`, тот же, что у `--moe-a2a-backend`)
- Допустимые значения: `none`, `deepep`, `mooncake`, `nixl`, `mori`, `ascend_fuseep`, `flashinfer`, `megamoe`, `pplx`, `ascend_tp`
- Значение по умолчанию: `null`
- Эффективное значение: в `__post_init__` остаётся `null`; `initialize_moe_config` при `None` подставляет `moe.a2a_backend` target-модели. Исключение — DeepSeek-семейство с `--quantization modelopt_fp4` на ROCm: `_deepseek_spec_moe_resolution` выставляет `deepep` (вместе с runner `deep_gemm`) при `SGLANG_NVFP4_CKPT_FP8_NEXTN_MOE`, иначе `none` (с runner `triton`)
- Где объявлен: `ServerArgs.speculative_moe_a2a_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `initialize_moe_config` при инициализации model runner → сборка и прогоны MoE-слоёв черновика внутри `speculative_moe_a2a_backend_context()`

## Что меняет в движке

`initialize_moe_config` (`sglang/python/sglang/srt/layers/moe/utils.py`) записывает значение в `moe.speculative_a2a_backend`, а при `None` — копирует туда уже разрешённый `moe.a2a_backend` target-модели.

Читается оно только внутри `speculative_moe_a2a_backend_context()`. Этот контекст-менеджер делает две вещи:

- подменяет активный `moe.a2a_backend` на спекулятивный;
- **безусловно выставляет `moe.disable_fp4_allgather = True`** на время черновика — комментарий в коде объясняет: MTP-слои не квантизованы, и FP4-allgather для них неприменим.

Контекстом обёрнуты сборка draft-модели, инициализация attention-бэкендов, захват CUDA graph и forward'ы черновика в EAGLE- и frozen-KV-MTP-воркерах (`sglang/python/sglang/srt/speculative/eagle_worker_v2.py`, `frozen_kv_mtp_worker_v2.py`). Отметьте: standalone-воркер оборачивает только runner-контекст, a2a-контекст там не применяется.

Помимо этого пара «спекулятивный runner + спекулятивный a2a» читается напрямую из `server_args` в `cuda_graph_setup` (решение, считать ли draft-воркер использующим DeepGEMM-раннер) и в `should_run_flashinfer_autotune(..., for_speculative_draft=True)` (отказ от автотюнинга FlashInfer для связки `flashinfer_cutedsl` + `deepep`).

Единственная валидация этого аргумента на старте — в `_handle_dspark`: при DSPARK с DP attention и `dp_size > 1` спекулятивный a2a обязан совпадать с `moe_a2a_backend` target-модели, иначе `ValueError`. Ни `_handle_a2a_moe`, ни `_handle_moe_kernel_config` спекулятивное значение не смотрят.

## Значения и формат

- Не задан — наследование значения target-модели во время инициализации. Дамп `server_args=` при этом показывает `speculative_moe_a2a_backend=None`; фактически применённое значение виден только по поведению (и по строкам инициализации DeepEP, если он включается).
- `none` — эксперты черновика считаются без межранговой пересылки, в пределах TP-группы. Самое частое осмысленное явное значение для одного MTP-слоя.
- `deepep` / `mooncake` / `nixl` / `mori` / `flashinfer` / `pplx` / `megamoe` — те же транспорты, что и для target-модели; каждый требует своих установленных пакетов и своей топологии `--ep-size`.
- `ascend_fuseep` / `ascend_tp` — только для NPU Ascend.
- Значение вне списка отвергает argparse. Значение из списка, но неподдержанное сборкой или топологией, здесь не проверяется — отказ придёт из инициализации диспетчера черновика.

## Когда использовать

- Target-модель на `--moe-a2a-backend deepep`, а черновик — один MTP-слой: `--speculative-moe-a2a-backend none` убирает выделение DeepEP-буферов и раунд all-to-all на каждый шаг черновика.
- Обратный случай — крупная MoE draft-модель (STANDALONE с MoE) при `--moe-a2a-backend none` у target-модели: можно попробовать `deepep`, но помните, что standalone-воркер этот контекст не применяет.
- Не задавать, если у черновика нет MoE-слоёв — значение не будет прочитано.
- Не менять вместе с `--speculative-moe-runner-backend` за один заход: у транспортных и вычислительных ядер есть взаимные требования (например DeepGEMM-путь FP8 в `auto` включается только при a2a из семейства DeepEP), и при одновременной смене непонятно, что именно сработало.

## Влияние на производительность и память

- VRAM: DeepEP и родственные транспорты выделяют собственные буферы обмена. Для target-модели это учтено в автоподборе `--mem-fraction-static` (`reserve_for_deepep_a2a_mb()`), для черновика — нет: если вы включаете a2a только у черновика, добавочный расход в резерв не заложен.
- Compute/latency: раунд all-to-all на каждый MoE-слой черновика, умноженный на `--speculative-num-steps` прогонов за decode-шаг. Для одного маленького слоя транспорт обычно дороже самих вычислений — отсюда рекомендация `none`.
- Время старта: инициализация транспорта и его буферов выполняется отдельно для черновика.
- Точность/численность: контекст черновика принудительно отключает FP4-allgather, независимо от `--disable-flashinfer-cutlass-moe-fp4-allgather`.
- RAM хоста: не влияет.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: источник значения по умолчанию (подставляется в `initialize_moe_config`, а не в `__post_init__`).
- `--speculative-moe-runner-backend`: парный аргумент; у него, наоборот, значение по умолчанию проставляется ещё в `__post_init__`. Совместимость пары «runner + a2a» для черновика не проверяется на старте.
- `--moe-runner-backend`: правила совместимости a2a и раннера (`flashinfer_cutedsl` ограничивает набор a2a, `pplx` требует `deep_gemm`) действуют для target-модели; на спекулятивную пару они не распространяются.
- `--ep-size`: транспорт имеет смысл только при экспертном параллелизме; при `ep_size = 1` любые значения, кроме `none`, добавляют накладные расходы без выгоды.
- `--deepep-mode`: применяется к DeepEP в целом; отдельного спекулятивного режима нет.
- `--speculative-algorithm`: под DSPARK с DP attention значение обязано совпадать с target-моделью; под NGRAM и DFLASH-без-MoE не читается.
- `--enable-dp-attention`: участвует в проверке DSPARK и в выборе схемы reduce у диспетчеров.

## Типовые проблемы и диагностика

- `DSpark ignores --speculative-moe-a2a-backend; with dp attention it must match the target moe_a2a_backend='…' (got '…')` — единственная явная проверка на старте.
- `Invalid configuration: 'deep_gemm' speculative MoE runner backend with 'deepep' a2a backend requires expert parallelism (ep_size > 1)` — ветка DeepSeek fp4 на ROCm попыталась включить DeepEP при `--ep-size 1`; поставьте `--ep-size` больше единицы или `--speculative-moe-a2a-backend none`.
- Падение при инициализации диспетчера черновика (отсутствующий пакет DeepEP/pplx/mooncake) — транспорт не установлен; проверьте, что он вообще работает для target-модели.
- В дампе `server_args=` стоит `None`, хотя вы ожидали унаследованное значение — это норма: подстановка происходит позже, в `initialize_moe_config`.
- Неожиданный рост VRAM при спекуляции — включённый у черновика a2a-транспорт с собственными буферами, не учтёнными в автоподборе `--mem-fraction-static`. Задайте долю статики явно.
- Чем подтвердить: дамп `server_args=` (заданное значение), сообщения инициализации выбранного транспорта в стартовом логе.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --speculative-algorithm NEXTN --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --speculative-moe-a2a-backend none --speculative-moe-runner-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --speculative-algorithm EAGLE --speculative-draft-model-path /models/qwen3-moe-eagle --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --speculative-moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/frozen_kv_mtp_worker_v2.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
