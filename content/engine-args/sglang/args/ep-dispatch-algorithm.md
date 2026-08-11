---
schema: 1
engine: sglang
primaryName: "--ep-dispatch-algorithm"
title: "--ep-dispatch-algorithm"
summary: Определяет, какую физическую реплику логического эксперта выбирает токен на forward-проходе. Значение подставляется автоматически, как только включен EPLB или задана нетривиальная стартовая раскладка, и часть значений запрещена при `--moe-a2a-backend none`.
group: exec.moe
related:
  - --enable-eplb
  - --init-expert-location
  - --ep-num-redundant-experts
  - --moe-a2a-backend
  - --enable-dp-attention
  - --ep-size
---

# --ep-dispatch-algorithm

## Кратко

Когда у логического эксперта больше одной физической реплики (это дает `--ep-num-redundant-experts` или сама перебалансировка), кто-то должен решить, в какую именно реплику отправить конкретный токен. Этим и занимается `ExpertLocationDispatchInfo`: он переводит логические `topk_ids` в физические. Аргумент выбирает правило перевода. Без реплик и без EPLB он не нужен — при `null` информация о диспетчеризации вообще не создается, и `topk_ids` идут как есть.

## Оригинальная справка

```text
The algorithm to choose ranks for redundant experts in expert parallel.
```

## Паспорт аргумента

- Флаги: `--ep-dispatch-algorithm`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `static`, `dynamic`, `fake`, `lp`
- Значение по умолчанию: `null`
- Эффективное значение: `_handle_eplb_and_dispatch` подставляет значение, если оно не задано, а включен `--enable-eplb` **или** `--init-expert-location` отличен от `trivial`: `dynamic` при `--moe-a2a-backend none`, `static` во всех остальных случаях. Кроме того, при `--moe-a2a-backend none` значения `static` и `lp` отвергаются `ValueError`
- Где объявлен: `ServerArgs.ep_dispatch_algorithm`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → построение `ExpertLocationMetadata` (для `static` считается отдельная таблица) → инициализация LP-решателей (для `lp`) → каждый forward-проход

## Что меняет в движке

Значение читается в `sglang/python/sglang/srt/eplb/expert_location_dispatch.py`:

- **`static`** — на каждом ранге лежит своя таблица `logical_to_rank_dispatch_physical_map` (одна запись на логического эксперта), и перевод сводится к индексации. Таблица строится в `compute_logical_to_rank_dispatch_physical_map` при создании метаданных: для каждого ранга сначала ищется ближайшая реплика (своя GPU, затем свой узел — второе включается для многоузловых конфигураций), а оставшимся рангам реплики раздаются честной жеребьевкой с фиксированным seed 42. Самый дешевый вариант на forward и самый «локальный» по трафику.
- **`dynamic`** — реплика выбирается на лету по числу доступных реплик. При `rank_invariant` (то есть при `--moe-a2a-backend none`) выбор делается по индексу строки в батче, чтобы все ранги гарантированно выбрали одно и то же; иначе берется псевдослучайный индекс. Таблица `static` при этом не строится вовсе.
- **`fake`** — `dynamic` плюс подмена входа маршрутизации: `router_logits` заполняются равномерным шумом в `[5, 10)`, а `correction_bias` обнуляется. Это инструмент для замеров пропускной способности при заведомо равномерной маршрутизации, а не рабочий режим — качество ответов он ломает.
- **`lp`** — выбор считает JIT-компилируемое CUDA-ядро по вероятностям, полученным из LP-решателя (`sglang/python/sglang/srt/eplb/lplb_solver.py`). Решатели создаются на слой при старте и пересобираются после каждой перебалансировки. Требования жесткие: только CUDA-тензоры (иначе `RuntimeError`) и только архитектуры из белого списка `_LPLB_SUPPORTED_MODEL_ARCHS` — семейство DeepSeek-V2/V3/V3.2, MistralLarge3, GLM4-MoE-Lite и GLM-MoE-DSA. Причина ограничения указана в коде: остальные MoE-семейства имеют ранние выходы на пустых батчах и не дошли бы до `all_reduce` внутри решателя, что под DP-attention дает дедлок.

Запрет `static`/`lp` при `--moe-a2a-backend none` объясняется тем же кодом: без a2a все EP-ранги считают MoE по одним и тем же токенам и складывают частичные результаты, поэтому расхождение в выборе реплики учло бы одного логического эксперта несколько раз.

## Значения и формат

- `null` — `ExpertLocationDispatchInfo.init_new` возвращает `None`, перевод логических идентификаторов в физические не выполняется. Единственный корректный вариант, когда реплик нет.
- `static` — детерминированный выбор по таблице; требует a2a-бэкенда.
- `dynamic` — равномерное размазывание по репликам; работает и с a2a, и без него.
- `fake` — диагностический; не используйте на инстансе, отдающем ответы пользователям.
- `lp` — требует CUDA и поддерживаемой архитектуры; отказ происходит на старте (`NotImplementedError` из `assert_lplb_supported_model`) либо на первом forward (`RuntimeError` про не-CUDA тензоры).

## Когда использовать

- Обычная EP-конфигурация с a2a-бэкендом и репликами: оставьте автоподстановку — она даст `static`, самый дешевый вариант.
- Гибрид EP+TP без a2a (`--moe-a2a-backend none`) с репликами: только `dynamic`, остальное отвергается на старте.
- `lp` — если вы готовы к дополнительному `all_reduce` на каждом MoE-слое ради более точной балансировки на модели из белого списка.
- `fake` — только на стенде, когда меряете «потолок» пропускной способности без влияния перекоса маршрутизации.

## Влияние на производительность и память

- **`static`.** Таблица `(num_layers, num_logical_experts)` int на ранг — единицы мегабайт. Построение таблицы идет на CPU в питоновских циклах по слоям и экспертам и добавляет секунды к старту и к каждой перебалансировке на крупных моделях.
- **`dynamic`.** Памяти не требует; на forward — генерация индекса и одна индексация на слой.
- **`lp`.** Самый дорогой: на каждый MoE-слой в каждом проходе идет `all_reduce` счетчиков по EP-группе плюс решение LP, затем CUDA-ядро выбора. Решатели пересобираются после перебалансировки.
- **`fake`.** Дополнительно перезаписывает `router_logits` на каждом слое.
- На VRAM модели ни одно значение существенно не влияет — реплики оплачивает `--ep-num-redundant-experts`.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: `none` запрещает `static` и `lp` и меняет умолчание на `dynamic`.
- `--enable-eplb` и `--init-expert-location`: каждый из них включает автоподстановку значения.
- `--ep-num-redundant-experts`: без реплик все алгоритмы вырождаются в тождественный перевод.
- `--enable-dp-attention`: под ним ранги могут получать пустые батчи — это и есть причина ограничения `lp` белым списком архитектур.
- `--ep-size`: определяет, между сколькими рангами раздаются реплики.

## Типовые проблемы и диагностика

- `ValueError: --ep-dispatch-algorithm static picks a different physical replica per rank ...` — `static` или `lp` вместе с `--moe-a2a-backend none`; поставьте `dynamic`.
- `NotImplementedError: <Arch> does not support --ep-dispatch-algorithm lp.` — архитектура вне белого списка LP.
- `RuntimeError: LP dispatch requires CUDA tensors` — попытка использовать `lp` не на CUDA.
- `RuntimeError: ep_dispatch_algorithm='lp' but log2phy_prob is None at dispatch time` — решатели не были инициализированы (например, слой вызывается вне обычного пути model runner).
- Долгий старт или долгая перебалансировка при `static` на модели с сотнями экспертов — это построение таблицы на CPU; при чувствительности к времени старта имеет смысл сравнить с `dynamic`.
- Бессмысленные ответы модели — проверьте, не остался ли `fake` в командной строке.
- Итоговое значение после автоподстановки — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --enable-eplb --ep-num-redundant-experts 32 --ep-dispatch-algorithm static
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 4 --ep-size 2 --moe-a2a-backend none --ep-num-redundant-experts 8 --ep-dispatch-algorithm dynamic
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_location_dispatch.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/eplb/lplb_solver.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/moe_ep_setup.py`
