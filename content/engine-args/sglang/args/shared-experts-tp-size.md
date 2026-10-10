---
schema: 1
engine: sglang
primaryName: "--shared-experts-tp-size"
title: "--shared-experts-tp-size"
summary: Только для Kimi-K3 с EP all-to-all backend'ом — ширина TP-шардирования shared experts, независимая от attention-TP. Значение должно делить attention-TP; `1` реплицирует веса на каждом rank'е; при заданном значении `--enable-shared-experts-attn-tp` больше не определяет ширину.
group: parallel
related:
  - --enable-shared-experts-attn-tp
  - --moe-a2a-backend
  - --tp-size
  - --enable-dp-attention
  - --dp-size
  - --enable-dense-mlp-attn-tp
---

# --shared-experts-tp-size

## Кратко

При expert-parallel all-to-all (`--moe-a2a-backend deepep|megamoe|mooncake|ascend_fuseep|mori`) каждый rank держит свою долю токенов, и shared experts Kimi-K3 работают над ней отдельно от routed-экспертов. По умолчанию их веса реплицируются (TP=1), а `--enable-shared-experts-attn-tp` шардирует их на всю attention-TP группу. Этот аргумент задает промежуточную ширину: shared experts шардируются по подгруппам из `N` соседних rank'ов внутри attention-TP, а входы собираются all-gather'ом только внутри подгруппы. Аргумент новый в checkout'е и пришел вместе с рецептом Kimi-K3 для Ascend; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Shared-expert TP size for Kimi-K3 with an expert-parallel all-to-all backend. Must divide attention TP size. Overrides --enable-shared-experts-attn-tp when set; 1 replicates the weights.
```

## Паспорт аргумента

- Флаги: `--shared-experts-tp-size`
- Группа: `parallel`
- Тип значения: optional int
- Допустимые значения: целое `≥ 1`, делитель attention-TP размера
- Значение по умолчанию: `null` — ширину определяет `--enable-shared-experts-attn-tp` (attention-TP) либо репликация
- Эффективное значение: совпадает с заданным; `handle_shared_experts_tp` (`arg_groups/parallel_hook.py`) только проверяет его, не переписывая
- Где объявлен: `python/sglang/srt/arg_groups/fields/parallel.py:Parallel.shared_experts_tp_size`
- Статус: обычный, узкоспециализированный (одна архитектура)
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_shared_experts_tp` (проверки) → `initialize_model_parallel` (создание группы `shared_experts_tp`) → конструктор MoE-слоя `kimi_k3.py` (шардирование весов) → forward каждого MoE-слоя

## Что меняет в движке

Проверки `handle_shared_experts_tp` при заданном значении:

- attention-TP размер выводится как в рантайме (`derive_attention_widths` из `--tp-size`, `--dp-size`, DP attention и attention-CP); значение должно быть его положительным делителем, иначе `ValueError: --shared-experts-tp-size (N) must be a positive divisor of attention TP size (M).`;
- архитектура модели — строго `KimiK3ForConditionalGeneration`, иначе `ValueError: --shared-experts-tp-size is only supported for Kimi-K3.`;
- `--moe-a2a-backend` — один из `deepep`, `megamoe`, `mooncake`, `ascend_fuseep`, `mori`.

Группа процессов (`initialize_model_parallel`, `distributed/parallel_state.py`):

- `N = 1` — группа не создается;
- `N` равно attention-TP — переиспользуется attention-TP группа;
- иначе создается отдельная группа `shared_experts_tp` из блоков по `N` подряд идущих rank'ов (блоки не пересекают границы attention-TP реплик и PP-стадий), без custom all-reduce и без symm-mem all-reduce.

В MoE-слое Kimi-K3 (`models/kimi_k3.py`) ширина выбирается так: заданный `--shared-experts-tp-size`, иначе attention-TP при `--enable-shared-experts-attn-tp`, иначе репликация. При ширине `> 1` forward shared-ветки делает `all_gather` входов в подгруппе, считает свою долю `intermediate_size` и `reduce_scatter` выхода обратно к локальным строкам. Произведение `moe_intermediate_size × число shared experts` должно делиться на ширину, иначе `ValueError: Shared-expert intermediate size (…) must be divisible by shared-expert TP size (…).` при загрузке модели.

## Значения и формат

- Целое число; `null` (не задан) — поведение определяют `--enable-shared-experts-attn-tp` и репликация по умолчанию.
- `1` — явная репликация: каждый rank держит полные веса shared experts и не делает коммуникаций в shared-ветке, даже если задан `--enable-shared-experts-attn-tp`.
- `N` = attention-TP — то же, что `--enable-shared-experts-attn-tp`.
- `1 < N < attention-TP` — подгруппы по `N` соседних rank'ов.
- `0`, отрицательное число и не делитель attention-TP — `ValueError` на старте.

## Когда использовать

- Kimi-K3 на большом attention-TP (например, TP32 с DP attention при `dp=1`): полная репликация shared experts стоит много памяти на каждом rank'е, а шардирование на все 32 rank'а дает слишком дорогие all-gather/reduce-scatter. Подгруппа по 4–8 соседних rank'ов (обычно внутри одного узла) — компромисс. Рецепт Kimi-K3 для Ascend 950 в upstream-cookbook использует `--shared-experts-tp-size 4` при `--tp-size 32`.
- Для других моделей аргумент бесполезен и отвергается на старте.
- Без EP all-to-all (`--moe-a2a-backend none`) аргумент тоже отвергается: в этом режиме shared experts идут обычным TP-путем модели.

## Влияние на производительность и память

- VRAM на rank: веса shared experts делятся на `N`; при `N = 1` — полная копия на каждом rank'е (в комментарии `kimi_k3.py` для bf16-реплики приводится порядка 264 МБ на слой на rank).
- Коммуникации: на каждом MoE-слое `all_gather` входов и `reduce_scatter` выходов внутри подгруппы из `N` rank'ов; объем растет с `N` и с числом токенов в батче. Подгруппа внутри узла дешевле, чем через межузловую сеть.
- Отдельная группа `shared_experts_tp` — дополнительный коммуникатор, создаваемый на старте.

## Взаимодействие с другими аргументами

- `--enable-shared-experts-attn-tp`: при заданном `--shared-experts-tp-size` его ширина не используется; рецепты задают оба флага, но решает значение этого аргумента.
- `--moe-a2a-backend`: обязателен один из EP all-to-all backend'ов.
- `--tp-size`, `--dp-size`, `--enable-dp-attention`: определяют attention-TP размер, который должен делиться на значение.
- `--enable-dense-mlp-attn-tp`: dense MLP шардируется отдельно; этот аргумент на него не влияет.

## Типовые проблемы и диагностика

- `ValueError: --shared-experts-tp-size (N) must be a positive divisor of attention TP size (M).` — пересчитайте attention-TP: при DP attention это `tp_size / dp_size` (с учетом attention-CP).
- `ValueError: --shared-experts-tp-size is only supported for Kimi-K3.` — модель другой архитектуры; уберите флаг.
- `ValueError: --shared-experts-tp-size requires an expert-parallel all-to-all backend (deepep, megamoe, mooncake, ascend_fuseep or mori).` — задайте `--moe-a2a-backend`.
- `ValueError: --shared-experts-tp-size requires a Kimi-K3 model configuration.` — модель загружается через instance-коннектор без HF-конфига, архитектуру проверить нельзя.
- `ValueError: Shared-expert intermediate size … must be divisible by shared-expert TP size …` — ширина не делит размер shared-ветки модели.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3 --trust-remote-code --tp-size 32 --enable-dp-attention --moe-a2a-backend deepep --enable-shared-experts-attn-tp --shared-experts-tp-size 4
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3 --trust-remote-code --tp-size 16 --enable-dp-attention --dp-size 2 --moe-a2a-backend deepep --shared-experts-tp-size 1
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/parallel.py`
- `sglang/python/sglang/srt/arg_groups/parallel_hook.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/models/kimi_k3.py`
- `sglang/docs/cookbook/autoregressive/Moonshotai/Kimi-K3.mdx`
- `sglang/docs/src/snippets/configs/moonshotai/kimi-k3.jsx`
