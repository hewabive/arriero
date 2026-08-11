---
schema: 1
engine: sglang
primaryName: "--lora-use-virtual-experts"
title: "--lora-use-virtual-experts"
summary: Альтернативный путь вычисления LoRA-дельты в MoE-слоях: пара «адаптер × эксперт» превращается в отдельного виртуального эксперта, и дельта считается штатной grouped-GEMM машинерией. Обязателен для экспериментального Marlin-пути.
group: lora
related:
  - --experts-shared-outer-loras
  - --lora-backend
  - --max-lora-rank
  - --max-loras-per-batch
  - --enable-lora
  - --ep-size
  - --moe-a2a-backend
---

# --lora-use-virtual-experts

## Кратко

В MoE-модели LoRA-дельту надо посчитать для каждой пары «токен → эксперт», причем адаптеры у токенов разные. Классический путь строит выравнивание токенов по экспертам с блочным паддингом и зовет `fused_moe_lora`. Путь виртуальных экспертов вместо этого **переписывает `topk_ids`**: эксперт `e` для токена с адаптером `l` становится виртуальным экспертом `e + l * num_experts`, после чего дельта считается обычным grouped-GEMM по `virtual_num_experts = num_experts × max_loras`. Флаг относится только к MoE-моделям и только к LoRA-тракту.

## Оригинальная справка

```text
Enable virtual expert computation for MoE models. When set, the model will use virtual expert computation.
```

## Паспорт аргумента

- Флаги: `--lora-use-virtual-experts`
- Группа: `lora`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; при включенной LoRA `check_lora_server_args` только печатает `Virtual expert computation enabled.`
- Где объявлен: `ServerArgs.lora_use_virtual_experts`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, но обслуживает экспериментальные пути (`lora/marlin_lora_temp/`, `lora/trtllm_lora_temp/`), названия которых прямо помечены как временные
- Этап применения: конструктор `LoRAManager` → построение `LoRAInfo` для MoE-слоев → каждый forward MoE-слоя с LoRA

## Что меняет в движке

Значение доезжает до `LoRAInfo.lora_use_virtual_experts` (`sglang/python/sglang/srt/lora/lora_moe_runners.py`) и разводит два пути в `build_lora_hooks`:

- **классический** — `_compute_lora_alignment(topk_ids, lora_info)` строит `sorted_token_ids`, `expert_ids`, `num_tokens_post_padded` с блочным паддингом (`BLOCK_SIZE_M = 64`) и передает их в `fused_moe_lora` отдельно для `gate_up` и для `down`;
- **виртуальный** — вычисляется только `token_lora_mapping`, а работу делает `merged_experts_fused_moe_lora_add` (`sglang/python/sglang/kernels/ops/moe/virtual_experts.py`).

Ядро `_fused_virtual_topk_ids_kernel` за один проход строит `virtual_topk_ids`:

```text
lora_id = token_lora_mapping[m]
mask[m] = (lora_id >= 0)
virtual_topk_ids[m, k] = topk_ids[m, k] + max(lora_id, 0) * num_experts_for_weight
```

с двумя важными деталями: отрицательные `topk_ids` (сентинел `-1` для неместных экспертов после EP-диспатча) сохраняются как есть — иначе они попали бы в чужой слот виртуального эксперта и вызвали чтение за границами; а при shared-outer режиме `num_experts_for_weight` становится `1`, и виртуальный id вырождается в номер адаптера. Итоговое число виртуальных экспертов — `num_experts_for_weight × max_loras`, и `fused_sanitize_expert_ids` глушит всё, что вышло за эту границу.

Практическая разница между путями:

- виртуальный путь не строит отдельное выравнивание и переиспользует routing-кеш между `gate_up` и `down`;
- классический путь при `experts_shared_outer_loras` вынужден раскрывать общий тензор на всех экспертов (`gate_up_a.expand(-1, num_experts, -1, -1)`, `down_lora_b.expand(...)`), а виртуальный работает с ним напрямую, без раскрытия;
- при `max_lora_rank == 0` (адаптеров нет) оба пути выходят сразу.

Отдельная жесткая зависимость: экспериментальная политика Marlin (`sglang/python/sglang/srt/lora/marlin_lora_temp/policy.py`) при включенной LoRA требует именно этот флаг и именно `--lora-backend triton`:

```text
ValueError: experimental_sgl_marlin LoRA requires --lora-use-virtual-experts
ValueError: experimental_sgl_marlin LoRA requires --lora-backend triton
```

## Значения и формат

- Флаг без значения; выключается только отсутствием.
- Осмыслен только для MoE-моделей с LoRA на экспертных модулях (`gate_up_proj_moe`, `down_proj_moe`). На плотной модели MoE-хуки не строятся, и флаг ни на что не влияет — кроме упомянутой проверки Marlin-политики.
- Никакой автоматики выбора между путями нет: движок не переключается на виртуальные эксперты сам.

## Когда использовать

- Требует того путь, который вы включаете: экспериментальный `experimental_sgl_marlin` без этого флага просто не стартует.
- Есть измеренная деградация на MoE + LoRA из-за паддинга выравнивания: при большом числе экспертов и малом числе токенов на эксперта классический путь платит за `num_experts × (BLOCK_SIZE_M − 1)` паддинговых строк, и виртуальный может оказаться дешевле.
- Используются shared-outer адаптеры (`--experts-shared-outer-loras`), и вы хотите избежать раскрытия общего тензора на всех экспертов.
- **Не включайте по умолчанию**: это не оптимизация «всегда лучше», а другой путь вычисления, привязанный к экспериментальным ядрам. Проверяйте на своей нагрузке и держите в уме, что контракт может измениться между релизами.
- **Не ожидайте эффекта** на плотных (non-MoE) моделях.

## Влияние на производительность и память

- **VRAM.** Размер LoRA-пула не меняется: буферы определяются `--max-loras-per-batch`, `--max-lora-rank` и целевыми модулями. Временные тензоры отличаются: виртуальный путь не выделяет `sorted_token_ids`/`expert_ids` под классическое выравнивание, но работает с бо́льшим числом «экспертов» в индексации.
- **Скорость.** Эффект зависит от отношения «число экспертов к числу токенов»: чем сильнее дробится батч по экспертам, тем дороже паддинг классического пути и тем выгоднее виртуальный.
- **Память при shared-outer.** Классический путь делает `expand` (view, а не копия), поэтому дополнительной аллокации там нет; выигрыш виртуального пути здесь в индексации, а не в байтах.
- **Время старта.** Триtоновские ядра виртуального пути компилируются при первом использовании.

## Взаимодействие с другими аргументами

- `--experts-shared-outer-loras`: комбинация обрабатывается специально. При виртуальном пути общий тензор используется напрямую (`experts_shared_outer_loras_a`/`_b` передаются в ядро), при классическом — раскрывается на всех экспертов.
- `--lora-backend`: экспериментальный Marlin-путь требует `triton`.
- `--ep-size`, `--moe-a2a-backend`: при EP `topk_ids` содержат сентинел `-1` для неместных экспертов; ядро виртуальных id это учитывает, но Marlin-политика дополнительно требует «тривиальной» раскладки экспертов (без `--ep-num-redundant-experts`, EPLB и elastic EP).
- `--max-lora-rank`: входит в число виртуальных экспертов через `max_loras` и в размерности ядер.
- `--enable-lora`: без неё поле не читается.

## Типовые проблемы и диагностика

- `ValueError: experimental_sgl_marlin LoRA requires --lora-use-virtual-experts` / `... requires --lora-backend triton` — включен Marlin-путь без нужной пары настроек.
- Ошибка компиляции Triton при первом MoE+LoRA запросе — попробуйте выключить флаг и сравнить с классическим путем; это быстрый способ локализовать проблему в ядре.
- Флаг включен, разницы нет: модель не MoE либо адаптеры не трогают экспертные модули (`gate_up_proj`/`down_proj` внутри `FusedMoE`).
- Единственное подтверждение в логе — информационная строка `Virtual expert computation enabled.` из `check_lora_server_args`; значение аргумента видно и в дампе `server_args=`.
- Расхождение численных результатов между двумя путями следует считать багом ядра, а не ожидаемым поведением: оба пути считают одну и ту же дельту.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B-Instruct --enable-lora --max-lora-rank 32 --lora-target-modules all --max-loras-per-batch 2 --lora-use-virtual-experts --lora-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B-Instruct --lora-paths moe=/models/lora/moe --max-loras-per-batch 2 --lora-use-virtual-experts --experts-shared-outer-loras
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/lora_moe_runners.py`
- `sglang/python/sglang/kernels/ops/moe/virtual_experts.py`
- `sglang/python/sglang/srt/lora/marlin_lora_temp/policy.py`
- `sglang/python/sglang/srt/lora/trtllm_lora_temp/lora_dispatch.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
