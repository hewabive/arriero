---
schema: 1
engine: sglang
primaryName: "--disable-shared-experts-fusion"
title: "--disable-shared-experts-fusion"
summary: Отключает вшивание shared expert в общий MoE-kernel для DeepSeek V3/R1 и родственных архитектур. Флаг часто выставляется автоматически — конкретными MoE-раннерами, a2a-бэкендами FlashInfer и DeepEP v2, `--load-format expert_pack` и для GigaChat 3.5, — а Waterfill, наоборот, принудительно его сбрасывает.
group: exec.moe
related:
  - --enforce-shared-experts-fusion
  - --enable-waterfill
  - --moe-runner-backend
  - --moe-a2a-backend
  - --quantization
  - --ep-size
  - --enable-two-batch-overlap
  - --load-format
---

# --disable-shared-experts-fusion

## Кратко

В DeepSeek-V3/R1 у каждого токена есть один shared expert, который считается всегда. Fusion превращает его в дополнительный слот того же fused-MoE-kernel: слой строится не на 256 экспертов и topk 8, а на 256 + число слитых слотов и topk 9, а загрузчик весов переклеивает `mlp.shared_experts` в `mlp.experts.256`. Флаг возвращает раздельный путь: shared expert считается отдельным dense-MLP и складывается с результатом MoE. Ручное отключение нужно редко — гораздо чаще fusion отключается сам, по несовместимости.

## Оригинальная справка

```text
Disable the built-in shared experts fusion optimization for DeepSeek V3/R1. Note: Waterfill (--enable-waterfill) routes the shared expert as an extra MoE slot, so the shared expert is not separated from the MoE path when Waterfill is enabled.
```

## Паспорт аргумента

- Флаги: `--disable-shared-experts-fusion`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: переопределяется проходами резолва из `python/sglang/srt/arg_groups/overrides.py` в обе стороны; итог декларируется через `declare_resolution`, а загрузчик читает его из `get_exec().moe`, не из сырого `server_args.disable_shared_experts_fusion`. В `true` — при `--load-format expert_pack` (шаг `handle_expert_pack`, `python/sglang/srt/arg_groups/expert_pack_hook.py`, вместе с `disable_cuda_graph`); для архитектур `GigaChat35ForCausalLM` / `GigaChat35ForCausalLMNextN` (модельный override `_gigachat35_overrides` в `python/sglang/srt/arg_groups/model_overrides/gigachat35.py`, шаг `handle_model_specific_adjustments`, без строки в логе); при `--moe-runner-backend` из набора `flashinfer_cutedsl`, `flashinfer_trtllm`, `experimental_sgl_trtllm`, `flashinfer_trtllm_routed` (проход `_moe_runner_fusion_disable` внутри шага `handle_moe_kernel_config`, с предупреждением); при `--moe-a2a-backend flashinfer` или `flashinfer_megamoe` (с предупреждением) и `deepep_v2` (молча) — проход `_a2a_fusion_adjustments` внутри шага `handle_a2a_moe`, оба последних шага — `python/sglang/srt/arg_groups/moe_hook.py`. В `false` — при `--enable-waterfill` с a2a `deepep`/`megamoe`
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecMoe.disable_shared_experts_fusion`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline` (шаги `handle_expert_pack`, `handle_model_specific_adjustments`, `handle_moe_kernel_config`, `handle_a2a_moe`) → загрузка модели (`install_shared_experts_fusion_decision`, один раз на runner, до создания слоев)

## Что меняет в движке

Решение принимается один раз в `install_shared_experts_fusion_decision` (`sglang/python/sglang/srt/layers/moe/utils.py`), которую вызывает загрузчик перед созданием модели:

```text
disabled = <значение аргумента>
if not disabled:
    reason = model_class.shared_experts_fusion_disable_reason(hf_config, quant_config)
    if reason: disabled = True
```

Отсюда следует практический вывод: **флаг сильнее любого автоматического включения.** Заявленное в справке `--enforce-shared-experts-fusion` взаимное исключение нигде не проверяется ассертом — при обоих флагах ворота модели просто не опрашиваются, и побеждает отключение. Единственное исключение — Waterfill, который сбрасывает значение раньше, еще при резолве (`_a2a_fusion_adjustments`).

Ворота семейства DeepSeek-V3 (`sglang/python/sglang/srt/models/deepseek_v2.py`) отключают fusion сами, если: включены SBO или TBO; выбран a2a-бэкенд класса DeepEP (там fusion выключен по умолчанию, и это ровно тот случай, ради которого существует `--enforce-shared-experts-fusion`); архитектура checkpoint'а не `DeepseekV3ForCausalLM`; `n_routed_experts` не 256 и не 384 (384 — только для Quark-MXFP4 checkpoint'а Kimi-K2.5); `n_shared_experts` не равен 1; недостаточная compute capability (ниже 8.0 на NVIDIA, ниже gfx942 на AMD, ниже 3.1 на MUSA); включен экспертный параллелизм на не-AMD платформе; квантизация W4AFP8 или W4A16. Причина печатается строкой `<причина> Shared experts fusion optimization is disabled.`

Результат читается моделью через `determine_num_fused_shared_experts` и превращается в `num_fused_shared_experts`, от которого зависят геометрия MoE-слоя, отображение имен весов при загрузке и число локальных экспертов на ранг.

## Значения и формат

- Флаг без значения. Отсутствие — «разрешить fusion, если модель и конфигурация его поддерживают».
- Наличие — «не делать fusion ни при каких условиях», кроме перезаписи со стороны Waterfill.
- На моделях, у которых нет ворот `shared_experts_fusion_disable_reason`, флаг остается единственным источником решения.

## Когда использовать

- Подозрение, что fused-путь дает неверные числа на нестандартном checkpoint'е: отключение возвращает эталонный раздельный путь и позволяет сравнить выход.
- Разбор проблем загрузки весов: при fusion загрузчик переклеивает `mlp.shared_experts` в слот `experts.<N>`, и ошибка в именах весов выглядит иначе, чем при раздельном пути.
- Не отключайте fusion «для экономии памяти»: раздельный путь держит отдельный dense-MLP и добавляет отдельный проход, он не дешевле.
- Не комбинируйте с `--enforce-shared-experts-fusion`: результат будет не тем, который читается из имен флагов.

## Влияние на производительность и память

- **Latency.** Fusion экономит отдельные запуски ядер и лишнюю редукцию: shared expert считается тем же grouped-GEMM, что и маршрутизируемые. Отключение возвращает эти запуски.
- **VRAM.** При fusion слой строится на большее число экспертов (`n_routed_experts + слоты shared`), при per-rank-раскладке — `n_routed_experts + ep_size`. Веса те же самые, меняется их размещение; заметного роста расхода нет.
- **A2A-трафик.** При DeepEP/MegaMOE с fusion shared expert едет через диспетчер как обычный эксперт; без fusion он считается локально и трафик не создает. Именно поэтому под DeepEP fusion по умолчанию отключен.
- **Throughput.** На поддерживаемых конфигурациях fusion выигрывает; вне их он либо невозможен, либо ворота отключат его сами.

## Взаимодействие с другими аргументами

- `--enforce-shared-experts-fusion`: заявлен как взаимоисключающий, но при одновременном указании выигрывает отключение — без ошибки и без предупреждения.
- `--enable-waterfill`: сбрасывает флаг в `false` с предупреждением; Waterfill без fusion не имеет смысла.
- `--moe-runner-backend`: FlashInfer CuteDSL/TRT-LLM раннеры выставляют флаг сами.
- `--moe-a2a-backend`: `flashinfer`, `flashinfer_megamoe` и `deepep_v2` выставляют флаг сами (fused shared experts с DeepEP v2 не проверены); прочие бэкенды класса DeepEP отключают fusion на уровне ворот модели.
- `--load-format expert_pack`: флаг выставляется вместе с отключением CUDA graph («for correctness»), а `--enforce-shared-experts-fusion` и `--enable-waterfill` при этом формате — ошибка `Invalid expert_pack configuration`.
- GigaChat 3.5 (`GigaChat35ForCausalLM` и его NextN-драфт): fusion выключается модельным override'ом безусловно.
- `--quantization`: W4AFP8 и W4A16 отключают fusion воротами модели.
- `--ep-size`: экспертный параллелизм на NVIDIA отключает fusion воротами.
- `--enable-two-batch-overlap`: TBO несовместим с fusion.

## Типовые проблемы и диагностика

- `DeepEP: fusion off by default (use --enforce-shared-experts-fusion to enable). Shared experts fusion optimization is disabled.` — штатное поведение под DeepEP, а не ошибка.
- `Config does not support fused shared expert(s). Shared experts fusion optimization is disabled.` — checkpoint не подходит по архитектуре или числу экспертов.
- `FlashInfer TRTLLM MoE is enabled. --disable-shared-experts-fusion is automatically set.` — флаг выставил раннер.
- `Flashinfer MoE A2A is enabled. --disable-shared-experts-fusion is automatically set.` — флаг выставил a2a `flashinfer` / `flashinfer_megamoe`; у `deepep_v2` и GigaChat 3.5 отдельной строки нет, итог виден только в дампе `server_args=`.
- `expert_pack selected: CUDA graph and shared-experts fusion are disabled for correctness.` — флаг выставлен форматом загрузки `expert_pack`.
- Waterfill не активировался (нет строки `Prepared N Waterfill TopK modules.`) — почти всегда потому, что fusion не состоялся; ищите строку с причиной.
- Ошибки вида «неизвестное имя веса `mlp.shared_experts...`» при загрузке — несоответствие между решением о fusion и checkpoint'ом; сравните решение в логе с ожидаемым.
- Итоговое значение аргумента после всех переопределений — в дампе `server_args=` при старте; фактическое решение по модели — в строке с причиной.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --disable-shared-experts-fusion
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-R1 --tp-size 8 --moe-runner-backend triton --disable-shared-experts-fusion --moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/moe_hook.py`
- `sglang/python/sglang/srt/arg_groups/expert_pack_hook.py`
- `sglang/python/sglang/srt/arg_groups/model_overrides/gigachat35.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
