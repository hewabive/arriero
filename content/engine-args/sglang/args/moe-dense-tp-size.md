---
schema: 1
engine: sglang
primaryName: "--moe-dense-tp-size"
title: "--moe-dense-tp-size"
summary: Отдельный TP-размер для плотных MLP внутри MoE-модели. Принимает только `None`, `1` или ровно `--tp-size`; значение `1` делает плотные слои полностью data-параллельными и убирает падения GEMM из-за слишком узких матриц.
group: parallel
related:
  - --tp-size
  - --enable-dp-attention
  - --enable-dp-lm-head
  - --ep-size
  - --moe-a2a-backend
  - --moe-dp-size
  - --enable-two-batch-overlap
  - --disable-attn-tp-gather
  - --enable-attn-tp-input-scattered
---

# --moe-dense-tp-size

## Кратко

У MoE-моделей часть слоев обычная, плотная (первые блоки DeepSeek, shared-эксперты и т. п.). По умолчанию они режутся тем же `--tp-size`, что и все остальное, и при большом TP их матрицы становятся настолько узкими, что GEMM-ядра либо теряют эффективность, либо падают на минимальной поддерживаемой размерности — ровно об этом говорит оригинальная справка. `--moe-dense-tp-size 1` отменяет для них шардирование: каждая attention-DP-группа считает плотный MLP целиком у себя. Значение по умолчанию `null`, и допустимых значений всего три.

## Оригинальная справка

```text
TP size for MoE dense MLP layers. This flag is useful when, with large TP size, there are errors caused by weights in MLP layers having dimension smaller than the min dimension GEMM supports.
```

## Паспорт аргумента

- Флаги: `--moe-dense-tp-size`
- Группа: `parallel`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `None`, `1` или ровно значение `--tp-size`. Проверка в `check_server_args`: `assert self.moe_dense_tp_size in (None, 1, self.tp_size)` с текстом `moe_dense_tp_size only supports None, 1, or tp_size currently`. Любое другое число argparse примет, а старт отвергнет
- Значение по умолчанию: `null` — «отдельного правила нет, плотные MLP живут по общим правилам TP»
- Эффективное значение: принудительно `1` в трех местах — `_handle_dwdp` (при `--dwdp-size > 1`), правила MLA CP и zigzag DSA CP в `arg_groups/overrides.py`, и хук DeepSeek-V4 CP (`arg_groups/deepseek_v4_hook.py`). Поле помечено `resolvable=True`
- Где объявлен: `ServerArgs.moe_dense_tp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (переопределения CP/DWDP) → `check_server_args` (валидация) → публикация в `ParallelState` → выбор режима scatter/gather в `LayerCommunicator` на каждом forward

## Что меняет в движке

Значение читается двумя предикатами:

- `enable_moe_dense_fully_dp()` в `layers/communicator.py` — это буквально `get_parallel().moe_dense_tp_size == 1`. Когда истинно, плотный MLP не шардируется: скрытые состояния остаются в раскладке attention-DP-группы, и после плотного слоя не нужен all-reduce по всей TP-группе.
- `require_mlp_tp_gather(server_args)` и `require_attn_tp_gather(server_args)` в `utils/common.py`. Первый решает, приходит ли вход MLP через all-gather вместо all-reduce; при `moe_dense_tp_size is None` он возвращает `True` сразу (в коде рядом стоит пометка, что не у всех MoE-моделей есть плотные слои), при заданном значении сравнивает `moe_dense_tp_size > tp_size // dp_size`. Второй возвращает `True`, если a2a-backend не `none` **или** `moe_dense_tp_size` задан.

Практическое следствие второго пункта: **само присутствие значения** (даже равного `tp_size`) включает путь с `gathered_buffer` и padding'ом числа токенов до `attn_tp_size`, чего при `None` не происходит. Отключить это можно `--disable-attn-tp-gather`.

`enable_moe_dense_fully_dp()` читает и `two_batch_overlap`: TBO проверяет `moe_dense_tp_size == 1` в своей логике подготовки ubatch'ей. Отдельно в планировщике (`scheduler_components/dp_attn.py`) стоит пометка, что случай `moe_dense_tp_size != 1` там еще не разобран.

## Значения и формат

- `1` — плотные MLP полностью data-параллельны в пределах attention-DP-группы. Веса плотных слоев при этом дублируются на каждой группе.
- `tp_size` — плотные MLP шардируются так же, как все, но путь gather включается явно.
- Не задан (`null`) — поведение по умолчанию: `require_mlp_tp_gather` при DP-attention возвращает `True` уже на первом условии.
- Любое другое число — `AssertionError` на старте, а не тихая деградация.

## Когда использовать

- Большой `--tp-size` (8 и выше) на модели, где `hidden_size / tp_size` или `intermediate_size / tp_size` становятся слишком малы: ставьте `1`. Это прямое назначение аргумента по оригинальной справке.
- Конфигурации DeepSeek/Kimi с DP-attention: `1` — типовой выбор, он же навязывается движком в CP-режимах.
- Не задавайте `tp_size` явно «чтобы ничего не менять»: это не то же самое, что не задавать вовсе — включится путь attn-tp-gather.
- Не ставьте `1` при `--tp-size 1`: делить и так нечего, эффекта не будет.

## Влияние на производительность и память

- **VRAM.** `1` дублирует веса плотных MLP на каждой attention-DP-группе. Для DeepSeek-подобных моделей это малая доля весов (плотных слоев единицы), для моделей с большой плотной частью — заметная.
- **Коммуникация.** `1` убирает all-reduce после плотного слоя и переводит стык на all-gather/scatter внутри DP-раскладки; на больших TP это обычно выигрыш.
- **GEMM.** Главный эффект: вместо `N` узких матриц одна полная. Узкие матрицы не только медленнее, но и могут не поддерживаться ядром — отсюда «errors» в справке.
- **CUDA graph.** Заданное значение (любое) включает `require_attn_tp_gather`, а с ним padding числа токенов до `attn_tp_size` в графовом раннере. На малых батчах это иногда заставляет автотюнер выбрать неподходящий вариант ядра — см. `--disable-attn-tp-gather`.
- **KV-кеш.** Не затрагивается.

## Взаимодействие с другими аргументами

- `--tp-size`: единственное разрешенное «не единичное» значение — ровно `tp_size`.
- `--enable-dp-attention`: без него `require_mlp_tp_gather` возвращает `False` целиком, и весь смысл `1` (полный DP плотных слоев) сводится к отсутствию шардирования в пределах всей TP-группы.
- `--enable-dp-lm-head`: участвует в той же цепочке условий `require_mlp_tp_gather`.
- `--moe-a2a-backend`: не `none` ⇒ `require_attn_tp_gather` истинен независимо от этого аргумента.
- `--enable-two-batch-overlap`: TBO-путь опирается на `moe_dense_tp_size == 1`.
- `--disable-attn-tp-gather`: единственный способ отменить включенный этим аргументом gather-путь.
- `--enable-attn-tp-input-scattered`: не включится, пока `enable_moe_dense_fully_dp()` истинно.
- Elastic EP: одноранговая присоединяющаяся группа (`tp_size == 1`) обязана иметь `--moe-dense-tp-size 1`.
- `--dwdp-size`, MLA CP, zigzag DSA CP, DeepSeek-V4 CP: выставляют `1` за вас.

## Типовые проблемы и диагностика

- `AssertionError: moe_dense_tp_size only supports None, 1, or tp_size currently` — задано число, которого нет в списке из трех.
- `AssertionError: A single-rank Elastic EP joining group requires --moe-dense-tp-size 1.` — присоединяющаяся группа с `tp_size == 1`.
- Падение GEMM или предупреждение ядра о минимальной размерности на большом TP — это исходный симптом, ради которого аргумент существует; ставьте `1`.
- Просадка на малых батчах после того, как значение было задано явно (даже `tp_size`) — включился `attn_tp_gather` с padding'ом; проверьте гипотезу флагом `--disable-attn-tp-gather`.
- В логе CP-режимов принудительная установка видна прямо: `For MLA CP, we have the following restrictions: moe_dense_tp_size == 1, moe_a2a_backend == deepep, ep_size == tp_size, batch_size == 1` и `Enable Context Parallel for DeepSeekV4, dp_size=…, moe_dense_tp_size=…`. Итоговое значение — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --ep-size 8 --moe-a2a-backend deepep --moe-dense-tp-size 1
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --tensor-parallel-size 8 --moe-dense-tp-size 1 --ep-size 8 --moe-a2a-backend none
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/batch_overlap/two_batch_overlap.py`
- `sglang/python/sglang/srt/managers/scheduler_components/dp_attn.py`
