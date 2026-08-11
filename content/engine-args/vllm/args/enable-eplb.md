---
schema: 1
engine: vllm
primaryName: "--enable-eplb"
title: "--enable-eplb"
summary: Включает сбор статистики нагрузки на экспертов и периодическую перекладку их между EP-рангами. Лечит перекос маршрутизации в MoE-моделях ценой постоянного учёта на каждом forward и памяти под избыточных экспертов.
group: ParallelConfig
related:
  - --enable-expert-parallel
  - --eplb-config
  - --expert-placement-strategy
  - --enable-elastic-ep
  - --enable-ep-weight-filter
  - --tensor-parallel-size
  - --data-parallel-size
  - --prefill-context-parallel-size
  - --gpu-memory-utilization
---

# --enable-eplb

## Кратко

MoE-модели обучают так, чтобы токены распределялись между экспертами более-менее равномерно, но на реальном трафике распределение перекашивается: часть рангов работает, часть ждёт. EPLB (Expert Parallel Load Balancer) собирает нагрузку по каждому физическому эксперту на каждом шаге и раз в `step_interval` шагов **физически перекладывает веса экспертов** между рангами так, чтобы выровнять нагрузку.

Флаг только включает механизм; все его параметры живут в `--eplb-config`. Ключевой из них — `num_redundant_experts`: дополнительные копии популярных экспертов, которые и дают балансировщику пространство для манёвра, но занимают VRAM.

## Оригинальная справка

```text
Enable expert parallelism load balancing for MoE layers.
```

## Паспорт аргумента

- Флаги: `--enable-eplb`, `--no-enable-eplb`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-eplb` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: сам флаг не переопределяется, но при `True` доопределяется `eplb_config.communicator`, если он не задан: NIXL при наличии пакета, иначе `pynccl` при `--enable-elastic-ep`, иначе `torch_gloo` (`ParallelConfig.__post_init__`)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_eplb`
- Этап применения: сборка `VllmConfig` (жёсткие проверки совместимости) → построение MoE-слоёв (резервирование избыточных физических экспертов) → каждый forward (учёт нагрузки) → периодическая перекладка весов

## Что меняет в движке

**Проверки на входе** (`ParallelConfig._validate_parallel_config`):

- платформа должна быть CUDA-подобной или ROCm: `Expert parallelism load balancing is only supported on CUDA devices or ROCm devices now.`;
- обязателен `--enable-expert-parallel`: `enable_expert_parallel must be True to use EPLB.`;
- EP-группа должна быть шире одного ранга: `tensor_parallel_size × prefill_context_parallel_size × data_parallel_size > 1`, иначе `EPLB requires tensor, prefill-context, or data parallelism, but got TP=..., PCP=..., DP=...`.

Зеркальная проверка: при **выключенном** EPLB ненулевой `num_redundant_experts` — ошибка.

**Логические и физические эксперты.** Глоссарий в `vllm/distributed/eplb/eplb_state.py`: логический эксперт — то, что есть в весах модели; физический — экземпляр на конкретном устройстве. С `num_redundant_experts` физических становится больше логических, и на каждый ранг приходится `(N_логических + N_избыточных) / ep_size` физических.

**Учёт.** `EplbState` держит скользящее окно нагрузки формы `(window_size, num_moe_layers, num_physical_experts)` и на каждом шаге увеличивает `expert_rearrangement_step`. Начальное значение счётчика ставится в `3/4` от `step_interval`, чтобы первая перекладка случилась раньше полного интервала.

**Перекладка.** По достижении `step_interval` вызывается `rearrange()`: политика (по умолчанию `default`) считает новое отображение логических экспертов на физические слоты, после чего веса переносятся между рангами выбранным коммуникатором. При `use_async=true` перенос выполняется фоновым worker'ом (`vllm/distributed/eplb/async_worker.py`), не блокируя шаг.

**Взаимодействие с загрузкой весов.** При включённом EPLB фильтр `--enable-ep-weight-filter` полностью отключается: избыточные слоты могут ссылаться на логических экспертов, «чужих» по умолчанию, поэтому загрузчику нужны все экспертные тензоры.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- `--no-enable-eplb` — явное подтверждение дефолта.
- Настройка целиком в `--eplb-config` (JSON-строкой или точечными под-флагами).
- Значение `num_redundant_experts = 0` допустимо: балансировка сведётся к перестановке существующих экспертов между рангами без добавления копий.

## Когда использовать

- **Видна скошенная нагрузка.** Проверяется включением `--eplb-config.log_balancedness true`: метрика — среднее число токенов на эксперта, делённое на максимум. Значение заметно ниже 1 означает перекос.
- **Крупное развёртывание MoE.** Апстрим рекомендует `num_redundant_experts` порядка 32 на больших конфигурациях, чтобы самые популярные эксперты были доступны на нескольких рангах.
- **Не включайте на тесной по VRAM карте.** Избыточные эксперты отбирают память у KV-cache; апстрим оценивает накладные расходы формулой `NUM_MOE_LAYERS × BYTES_PER_EXPERT × (N_экспертов + N_избыточных) / ep_size` — для DeepSeek-V3 это около 2,4 ГиБ на одного избыточного эксперта на ранг.
- **Не включайте «на всякий случай».** Учёт нагрузки идёт на каждом forward, а `log_balancedness` дополнительно добавляет коммуникацию (об этом прямо сказано в описании поля).

## Влияние на производительность и память

- **VRAM.** Растёт на объём избыточных экспертов плюс буферы перекладки. При том же `--gpu-memory-utilization` это вычитается из KV-cache.
- **Throughput.** Растёт, если перекос был реальным: простаивавшие ранги получают работу. При равномерной маршрутизации — только накладные расходы.
- **Latency.** Синхронная перекладка (`use_async=false`) даёт периодический всплеск времени шага. Асинхронная (по умолчанию) его размазывает, но требует совместимого коммуникатора.
- **Время старта.** Заметно не меняется; при выключенном фильтре весов загрузка чекпоинта идёт полностью, без экономии ввода-вывода.
- **Хост.** Коммуникатор `torch_gloo` проводит веса через CPU-буферы, то есть добавляет трафик host↔device и нагрузку на RAM.

## Взаимодействие с другими аргументами

- `--enable-expert-parallel`: обязателен.
- `--eplb-config`: все параметры механизма.
- `--expert-placement-strategy`: при включённом EPLB стратегия `round_robin` откатывается на `linear` с предупреждением.
- `--enable-ep-weight-filter`: при EPLB не действует (фильтр пропускается целиком).
- `--enable-elastic-ep`: требует EPLB и меняет автовыбор коммуникатора на `pynccl`, если NIXL недоступен.
- `--tensor-parallel-size`, `--data-parallel-size`, `--prefill-context-parallel-size`: их произведение должно быть больше 1.
- `--gpu-memory-utilization`: бюджет тот же, а избыточные эксперты — новая статья расхода внутри него.

## Типовые проблемы и диагностика

- **Симптом:** `enable_expert_parallel must be True to use EPLB.` **Лечение:** добавить `--enable-expert-parallel`.
- **Симптом:** `EPLB requires tensor, prefill-context, or data parallelism, but got TP=1, PCP=1, DP=1.` **Причина:** экспертная группа из одного ранга. **Лечение:** поднять TP или DP.
- **Симптом:** `Expert parallelism load balancing is only supported on CUDA devices or ROCm devices now.` **Причина:** неподдерживаемая платформа.
- **Симптом:** `num_redundant_experts is set to N but EPLB is not enabled. Either enable EPLB or unset num_redundant_experts.` **Причина:** параметр задан без флага.
- **Симптом:** после включения EPLB упал `GPU KV cache size` и выросли вытеснения. **Причина:** избыточные эксперты съели бюджет. **Лечение:** уменьшить `num_redundant_experts` либо поднять `--gpu-memory-utilization`.
- **Симптом:** `Async EPLB is only supported with the default policy.` или `torch_nccl communicator is incompatible with async EPLB due to NCCL multi-stream conflicts.` **Причина:** несовместимая комбинация в `--eplb-config`. **Лечение:** оставить `policy: default` и коммуникатор `torch_gloo`/`nixl` либо не задавать его вовсе.
- **Подтверждение принятого значения:** строка стартового конфига содержит `enable_eplb=True`; при `log_balancedness` в периодическом логе появляются строки балансированности и обратный отсчёт `steps until the next rearrangement`.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --enable-eplb --tensor-parallel-size 4 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --enable-eplb --data-parallel-size 8 --eplb-config '{"num_redundant_experts":32,"log_balancedness":true}'
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/distributed/eplb/eplb_state.py`
- `vllm/vllm/distributed/eplb/rebalance_execute.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/model_executor/layers/fused_moe/expert_map_manager.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
