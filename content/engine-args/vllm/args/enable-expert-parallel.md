---
schema: 1
engine: vllm
primaryName: "--enable-expert-parallel"
title: "--enable-expert-parallel"
summary: Переключает MoE-слои с тензорного шардирования на экспертное: каждый ранг держит свой набор экспертов целиком, а токены ходят между рангами через all2all. Корневой флаг всего семейства EP/EPLB; для не-MoE модели старт падает.
group: ParallelConfig
related:
  - --enable-eplb
  - --eplb-config
  - --expert-placement-strategy
  - --enable-ep-weight-filter
  - --enable-elastic-ep
  - --all2all-backend
  - --tensor-parallel-size
  - --data-parallel-size
  - --prefill-context-parallel-size
---

# --enable-expert-parallel

## Кратко

Без этого флага MoE-слои шардируются так же, как все остальные, — по тензорной размерности: каждый ранг держит по куску **каждого** эксперта. С флагом они переходят на экспертный параллелизм: ранг держит целиком **свой** набор экспертов, а токены маршрутизируются к нужному рангу через all2all-обмен.

Размер экспертной группы считается автоматически и равен `data_parallel_size × prefill_context_parallel_size × tensor_parallel_size` — отдельного аргумента для размера экспертной группы у vLLM нет. Слои внимания при этом ведут себя иначе: при `TP = 1` они реплицируются по DP-рангам, при `TP > 1` шардируются тензорно внутри каждой DP-группы.

Это корневой флаг семейства: `--enable-eplb`, `--eplb-config`, `--expert-placement-strategy`, `--enable-ep-weight-filter` и `--enable-elastic-ep` без него либо бессмысленны, либо прямо отвергаются.

## Оригинальная справка

```text
Use expert parallelism instead of tensor parallelism for MoE layers.
```

## Паспорт аргумента

- Флаги: `--enable-expert-parallel`, `--no-enable-expert-parallel`, `-ep`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-expert-parallel` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется, но при `True` управляет производными свойствами `ParallelConfig.use_all2all`, `use_sequence_parallel_moe`, `use_batched_dp_moe` и полем `use_ep` в `FusedMoEParallelConfig`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_expert_parallel`
- Этап применения: сборка `VllmConfig` (проверка «модель действительно MoE») → построение слоёв MoE и карты экспертов → загрузка весов → каждый forward MoE-слоя (all2all)

## Что меняет в движке

**Проверка модели.** `ModelConfig.verify_with_parallel_config()` при включённом EP вызывает `_verify_with_expert_parallelism()`, который требует ненулевого числа экспертов: `Number of experts in the model must be greater than 0 when expert parallelism is enabled.` На плотной модели старт падает сразу.

**Плоская экспертная группа.** `FusedMoEParallelConfig.flatten_tp_across_dp_and_pcp` считает

```
ep_size = data_parallel_size × prefill_context_parallel_size × tensor_parallel_size
ep_rank = dp_rank × pcp_size × tp_size + pcp_rank × tp_size + tp_rank
```

То есть EP «расплющивает» три оси в одну. Дальше `determine_expert_map(ep_size, ep_rank, global_num_experts, expert_placement_strategy, ...)` строит карту «глобальный индекс эксперта → локальный», раскладывая экспертов по рангам как можно ровнее; остаток достаётся первым рангам.

**Коммуникация.** `ParallelConfig.use_all2all` становится истинным при `data_parallel_size > 1`, при sequence-parallel MoE или при `enable_expert_parallel and prefill_context_parallel_size > 1`. Конкретное ядро выбирает `--all2all-backend` (по умолчанию `allgather_reducescatter`; DeepEP/MoRI/NIXL/FlashInfer требуют отдельно установленных ядер).

**Sequence-parallel MoE.** `use_sequence_parallel_moe` включается для набора backend'ов при `enable_expert_parallel and tensor_parallel_size > 1 and data_parallel_size > 1`. Смысл в комментарии к свойству: after-attention all-reduce делает входы одинаковыми на всех TP-рангах, и без sequence-parallel вход экспертов считался бы дублирующе.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False` = MoE-слои шардируются тензорно.
- `--no-enable-expert-parallel` — явное подтверждение дефолта.
- Алиас `-ep`.
- Размер EP-группы не задаётся напрямую: он выводится из `--tensor-parallel-size`, `--data-parallel-size` и `--prefill-context-parallel-size`.

## Когда использовать

- **MoE-модель на нескольких картах.** Типовая раскладка из апстрим-документации: `--tensor-parallel-size 1 --data-parallel-size 8 --enable-expert-parallel` — внимание реплицируется, эксперты делятся на восемь.
- **Эксперты доминируют по весам.** У DeepSeek-подобных моделей на экспертов приходится основная часть параметров, и именно их выгодно делить, а не резать каждый по TP.
- **Нужен `--enable-ep-weight-filter`.** Пропуск чужих экспертных тензоров при загрузке возможен только при активном EP.
- **Не включайте для плотной модели** — старт упадёт с явной ошибкой.
- **Не включайте на одной карте.** При `dp = pcp = tp = 1` экспертная группа вырождается в размер 1 (`determine_expert_map` возвращает карту `None`), выигрыша нет, а лишние ветки кода включаются.

## Влияние на производительность и память

- **VRAM.** Вес экспертной части на карту ≈ `общий вес экспертов / ep_size`. Не-экспертные слои остаются такими, какими их сделали TP и DP: при `TP = 1` внимание полностью реплицируется на каждой карте.
- **Трафик.** Вместо all-reduce после MoE-слоя появляется пара all2all-обменов (dispatch/combine) на слой. Это иной профиль нагрузки на межкарточный линк: чувствителен к пропускной способности и к балансу маршрутизации.
- **Балансировка.** При скошенном распределении токенов часть рангов простаивает — именно эту проблему решает `--enable-eplb`.
- **Время старта.** Меняется незначительно, если не включён `--enable-ep-weight-filter` (он сокращает дисковый ввод-вывод в разы для чекпоинтов с потензорными экспертами).
- **KV-cache.** Напрямую не меняется: EP касается только MoE-слоёв.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`, `--data-parallel-size`, `--prefill-context-parallel-size`: перемножаются в `ep_size`.
- `--all2all-backend`: выбирает ядро обмена. Значения `pplx` и `naive` уже удалены — конфиг это заметит и с предупреждением откатится на `allgather_reducescatter`.
- `--enable-eplb`: требует включённого EP (`enable_expert_parallel must be True to use EPLB.`).
- `--expert-placement-strategy`: определяет, какие именно глобальные индексы экспертов достанутся рангу.
- `--enable-ep-weight-filter`: включается только при активном EP и MoE-модели.
- `--enable-elastic-ep`: требует `--enable-eplb`, а тот — этого флага.
- `--enable-dbo`, `--ubatch-size`: микробатчинг придуман, чтобы перекрывать именно all2all-обмен вычислением; требует DeepEP/NIXL-backend'ов.

## Типовые проблемы и диагностика

- **Симптом:** `Number of experts in the model must be greater than 0 when expert parallelism is enabled.` **Причина:** флаг задан для плотной модели. **Лечение:** убрать флаг.
- **Симптом:** `The 'pplx' all2all backend has been removed. Falling back to 'allgather_reducescatter'.` **Причина:** устаревшее значение `--all2all-backend`. **Лечение:** выбрать актуальный backend.
- **Симптом:** throughput ниже, чем без EP, при `dp = 1`. **Причина:** экспертная группа равна `tp`, all2all добавлен, а выигрыша по памяти почти нет. **Лечение:** либо строить раскладку с DP, либо отказаться от EP.
- **Симптом:** сильный перекос загрузки карт на MoE-модели. **Причина:** маршрутизация токенов скошена. **Лечение:** `--enable-eplb` (см. его документ), при необходимости с избыточными экспертами.
- **Симптом:** ошибки инициализации DeepEP/NVSHMEM (`init failed for transport: IBGDA`, `cannot register cq buf`). **Причина:** выбран backend, чьи ядра или драйверы не установлены. **Лечение:** вернуться на `allgather_reducescatter` либо доустановить ядра по `vllm/docs/serving/expert_parallel_deployment.md`.
- **Подтверждение принятого значения:** строка стартового конфига содержит `enable_expert_parallel=True`; при активном фильтре весов дополнительно `EP weight filter: ep_size=..., ep_rank=..., loading N/M experts`.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --enable-expert-parallel --tensor-parallel-size 2 --gpu-memory-utilization 0.9
```

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --tensor-parallel-size 1 --data-parallel-size 8 --all2all-backend deepep_low_latency
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/layers/fused_moe/config.py`
- `vllm/vllm/model_executor/layers/fused_moe/expert_map_manager.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
- `vllm/docs/configuration/optimization.md`
