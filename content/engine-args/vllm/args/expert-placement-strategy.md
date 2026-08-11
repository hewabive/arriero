---
schema: 1
engine: vllm
primaryName: "--expert-placement-strategy"
title: "--expert-placement-strategy"
summary: Как глобальные индексы экспертов раскладываются по EP-рангам — подряд (`linear`) или через один (`round_robin`). Второй вариант выравнивает нагрузку в моделях с группами экспертов, но тихо откатывается на `linear` в большинстве конфигураций.
group: ParallelConfig
related:
  - --enable-expert-parallel
  - --enable-eplb
  - --eplb-config
  - --enable-ep-weight-filter
  - --all2all-backend
---

# --expert-placement-strategy

## Кратко

Флаг отвечает на один вопрос: какие глобальные индексы экспертов достанутся рангу. `linear` даёт непрерывный отрезок (`ранг 0 → [0,1]`, `ранг 1 → [2,3]`), `round_robin` — чередование (`ранг 0 → [0,2]`, `ранг 1 → [1,3]`).

Разница имеет смысл для моделей, у которых эксперты сгруппированы: при групповой маршрутизации соседние индексы часто активируются вместе, и непрерывная раскладка сажает всю группу на один ранг.

Главное практическое предупреждение: `round_robin` поддержан узко. При невыполнении любого из условий движок **молча** (точнее, с предупреждением в логе) откатывается на `linear`.

## Оригинальная справка

```text
The expert placement strategy for MoE layers:

- "linear": Experts are placed in a contiguous manner. For example, with 4
  experts and 2 ranks, rank 0 will have experts [0, 1] and rank 1 will have
  experts [2, 3].
- "round_robin": Experts are placed in a round-robin manner. For example,
  with 4 experts and 2 ranks, rank 0 will have experts [0, 2] and rank 1
  will have experts [1, 3]. This strategy can help improve load balancing
  for grouped expert models with no redundant experts.
```

## Паспорт аргумента

- Флаги: `--expert-placement-strategy`
- Группа argparse: `ParallelConfig`
- Тип значения: строка-перечисление (`ExpertPlacementStrategy`)
- Допустимые значения: `linear`, `round_robin`
- Значение по умолчанию: `linear`
- Эффективное значение: `round_robin` откатывается на `linear` в `determine_expert_placement_strategy` (`vllm/model_executor/layers/fused_moe/expert_map_manager.py`), если модель не имеет более одной группы экспертов, либо `num_redundant_experts != 0`, либо включён EPLB, либо используются all2all-ядра, не относящиеся к DeepEP low-latency / NIXL EP
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.expert_placement_strategy`
- Этап применения: построение MoE-слоёв (карта экспертов) → загрузка весов (в том числе фильтр `--enable-ep-weight-filter`)

## Что меняет в движке

`determine_expert_map(ep_size, ep_rank, global_num_experts, expert_placement_strategy, ...)` строит тензор длины `global_num_experts` со значением `-1` для чужих экспертов и локальным индексом для своих. Количество локальных экспертов одинаково для обеих стратегий (`base = N // ep_size`, остаток достаётся первым рангам) — различается только выбор индексов:

- `linear`: `start = ep_rank × base + min(ep_rank, remainder)`, дальше подряд;
- `round_robin`: `torch.arange(ep_rank, global_num_experts, ep_size)`.

Ту же стратегию использует `compute_local_expert_ids` в `vllm/model_executor/model_loader/ep_weight_filter.py`, поэтому при активном `--enable-ep-weight-filter` фильтр читает ровно тот набор экспертных тензоров, который соответствует выбранной раскладке.

Откат на `linear` в `determine_expert_placement_strategy` происходит по двум независимым проверкам:

1. `round_robin_supported = (num_expert_group is not None and num_expert_group > 1) and num_redundant_experts == 0 and not enable_eplb`. Иначе — `Round-robin expert placement is only supported for models with multiple expert groups and no redundant experts. Falling back to linear expert placement.`
2. Если MoE использует all2all-ядра, но backend не относится к тем, что строят round-robin-таблицы маршрутизации (`needs_round_robin_routing_tables` истинно только для DeepEP low-latency и NIXL EP) — `Round-robin expert placement currently only supports the DeepEP low-latency or NIXL EP backend, but '%s' was configured. Falling back to linear expert placement.`

## Значения и формат

- `linear` — раскладка подряд. Значение по умолчанию, работает всегда.
- `round_robin` — чередование по модулю `ep_size`. Действует только при выполнении условий выше.
- Других значений нет: `determine_expert_map` на неизвестной стратегии бросает `ValueError` с перечислением допустимых.
- Флаг применяется независимо от того, включён ли EP: при `ep_size == 1` карта экспертов вырождается в `None`, и стратегия ни на что не влияет.

## Когда использовать

- **Модель с несколькими группами экспертов и DeepEP low-latency / NIXL EP backend, без избыточных экспертов и без EPLB.** Это ровно тот случай, ради которого стратегия добавлена: чередование разводит эксперты одной группы по разным рангам.
- **Не используйте вместе с `--enable-eplb`.** EPLB сам переставляет экспертов динамически, статическая стратегия ему не нужна и будет отменена.
- **Не рассчитывайте на `round_robin` без проверки лога.** Откат тихий по отношению к результату: движок продолжит работу с `linear`, и вы узнаете об этом только из предупреждения.

## Влияние на производительность и память

- **VRAM.** Не влияет: число локальных экспертов одинаково для обеих стратегий, меняется только выбор индексов.
- **Throughput.** Может вырасти на групповых MoE за счёт более ровного распределения токенов по рангам; на моделях без групп разницы нет.
- **Время старта.** Не влияет само по себе. Косвенно: при `--enable-ep-weight-filter` стратегия определяет, какие тензоры будут прочитаны с диска, но их объём одинаков.
- **Latency.** Прямого влияния нет.

## Взаимодействие с другими аргументами

- `--enable-expert-parallel`: без него экспертная группа равна 1 и стратегия не проявляется.
- `--enable-eplb`: включает откат на `linear`.
- `--eplb-config`: ненулевой `num_redundant_experts` тоже включает откат.
- `--all2all-backend`: `round_robin` доживает до применения только с DeepEP low-latency или NIXL EP.
- `--enable-ep-weight-filter`: использует ту же стратегию для вычисления множества локальных экспертов, поэтому значения обязаны совпадать — они и берутся из одного поля конфига.

## Типовые проблемы и диагностика

- **Симптом:** задали `round_robin`, а в логе `Round-robin expert placement is only supported for models with multiple expert groups and no redundant experts. Falling back to linear expert placement.` **Причина:** у модели одна группа экспертов, либо заданы избыточные эксперты, либо включён EPLB. **Лечение:** убрать флаг — эффекта от него всё равно не будет.
- **Симптом:** `Round-robin expert placement currently only supports the DeepEP low-latency or NIXL EP backend, but 'allgather_reducescatter' was configured. Falling back to linear expert placement.` **Лечение:** либо перейти на `--all2all-backend deepep_low_latency`/`nixl_ep` (с установленными ядрами), либо остаться на `linear`.
- **Симптом:** `Unsupported expert placement strategy '...', expected one of ('linear', 'round_robin')`. **Причина:** опечатка в значении.
- **Подтверждение принятого значения:** отсутствие предупреждений об откате плюс строка `EP weight filter: ep_size=..., ep_rank=..., loading N/M experts` при активном фильтре — набор экспертов в ней соответствует выбранной раскладке.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --expert-placement-strategy round_robin --all2all-backend deepep_low_latency --data-parallel-size 8
```

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --expert-placement-strategy linear --tensor-parallel-size 4
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/model_executor/layers/fused_moe/expert_map_manager.py`
- `vllm/vllm/model_executor/layers/fused_moe/config.py`
- `vllm/vllm/model_executor/model_loader/ep_weight_filter.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
