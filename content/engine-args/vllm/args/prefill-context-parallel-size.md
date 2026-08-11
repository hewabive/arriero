---
schema: 1
engine: vllm
primaryName: "--prefill-context-parallel-size"
title: "--prefill-context-parallel-size"
summary: Делит вычисление prefill длинного запроса между дополнительными рангами, чтобы сократить TTFT. Расширяет мир процессов, но не увеличивает число шардов KV-cache; сегодня требует Model Runner V2 и MLA-модель, и несовместим с data parallelism.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --decode-context-parallel-size
  - --data-parallel-size
  - --cp-kv-cache-interleave-size
  - --enable-expert-parallel
  - --max-model-len
  - --max-num-batched-tokens
---

# --prefill-context-parallel-size

## Кратко

Context parallelism решает задачу длинного контекста и делится на две половины: PCP занимается prefill, DCP — decode. `--prefill-context-parallel-size N` (алиас `-pcp`) раскладывает вычисление префикса длинного запроса на N рангов, чтобы сократить время до первого токена.

Ключевое отличие от `--decode-context-parallel-size`: PCP **расширяет мир процессов** (`world_size = pp × tp × pcp`, то есть требует дополнительных карт), но, как прямо сказано в справке, не увеличивает число шардов KV-cache. DCP наоборот — шардирует KV-cache, не добавляя процессов.

Возможность молодая. В апстрим-документации обе стратегии PCP описаны как «under active development», а в коде она требует Model Runner V2, модель с MLA и запрещена вместе с data parallelism.

## Оригинальная справка

```text
Number of ranks that split prefill sequence computation. PCP expands
the process world size but does not increase the KV-cache shard count.
```

## Паспорт аргумента

- Флаги: `--prefill-context-parallel-size`, `-pcp`
- Группа argparse: `ParallelConfig`
- Тип значения: int
- Допустимые значения: `Field(default=1, ge=1)` — целое не меньше 1
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется, но при `> 1` **переопределяет соседей**: `VllmConfig.use_v2_model_runner` принудительно возвращает `True` (PCP реализован только в V2), и меняются допустимые значения `--decode-context-parallel-size`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.prefill_context_parallel_size`
- Этап применения: сборка `VllmConfig` (валидация, выбор Model Runner) → запуск worker-процессов → выбор attention-backend'а → prefill каждого запроса

## Что меняет в движке

**Мир процессов.** `ParallelConfig.__post_init__`: `world_size = pipeline_parallel_size × tensor_parallel_size × prefill_context_parallel_size`. `MultiprocExecutor` утверждает это равенство при старте.

**Ограничения** (`ParallelConfig._validate_parallel_config`):

- `PCP does not support data parallelism yet.` при `pcp > 1 and data_parallel_size > 1`;
- допустимые размеры DCP при `pcp > 1` сужаются до `{1, pcp, tp × pcp}`: `When PCP is enabled, DCP must be disabled, span the PCP axis, or span the full TP x PCP axis. Got TP=..., PCP=..., DCP=...; valid DCP sizes are [...]`.

**Model Runner.** `VllmConfig.use_v2_model_runner` возвращает `True` при `pcp > 1` с комментарием «PCP runtime support is implemented only by the V2 model runner». Если V2 отключён переменной окружения, старт падает: `Prefill context parallelism requires Model Runner V2. Remove VLLM_USE_V2_MODEL_RUNNER=0.`

**MLA.** `_validate_v2_model_runner` заносит `prefill context parallelism` в список неподдерживаемого, если модель не использует MLA. То есть на обычной GQA-модели PCP сегодня не работает.

**Гибридное внимание.** `vllm/v1/core/kv_cache_coordinator.py` содержит утверждение `PCP not support hybrid attn now.` — модели с разнородными attention-слоями исключены.

**Attention-backend.** `vllm/v1/attention/selector.py` передаёт `use_pcp = prefill_context_parallel_size > 1` при выборе backend'а; MLA-индексер (`vllm/v1/attention/backends/mla/indexer.py`) делит `slot_mapping` на `pcp_world_size` и собирает его обратно через `get_pcp_group().all_gather(...)`.

**MoE.** PCP входит в плоскую экспертную группу наравне с DP: `ep_size = dp × pcp × tp`, а `ParallelConfig.use_all2all` становится истинным при `enable_expert_parallel and pcp > 1`.

## Значения и формат

- Целое ≥ 1. `1` — PCP выключен.
- `0` отвергается валидацией `ge=1`.
- Алиас `-pcp`.
- Значение умножается на TP и PP при расчёте числа процессов: `-tp 8 -pcp 2` — это 16 карт, а не 8.
- Не путайте с `-dcp`: тот не добавляет процессов, а только сокращает дублирование KV-cache внутри существующих TP-рангов.

## Когда использовать

- **Очень длинные запросы, где TTFT — контролируемый SLO.** Это заявленная цель: амортизировать вычисление prefill по query-токенам.
- **Только на MLA-моделях и только с Model Runner V2.** Вне этого сочетания старт остановится с явной ошибкой.
- **Не используйте вместе с data parallelism** — прямой запрет в конфиге.
- **Не путайте с экономией памяти.** PCP не уменьшает KV-cache: справка говорит об этом прямо, и это главное отличие от DCP. Если задача в том, чтобы вместить больше токенов, вам нужен `-dcp` (и/или больший `-tp`).
- **Считайте возможность развивающейся.** Проверять её наличие в конкретной сборке — `vllm serve --help` в нужном окружении.

## Влияние на производительность и память

- **VRAM.** Требует дополнительных карт (мир растёт в `pcp` раз), но KV-cache при этом не шардируется дополнительно. Стоимость по устройствам растёт быстрее, чем ёмкость.
- **TTFT.** Ради этого всё и делается: вычисление prefill длинного запроса распределяется по `pcp` рангам.
- **Throughput при коротких запросах.** Выигрыша нет, а накладные расходы на дополнительные коллективы есть.
- **Время старта.** Растёт вместе с числом процессов: каждый ранг грузит свой шард и проходит компиляцию.
- **Latency decode.** PCP относится к prefill; decode-фаза от него не ускоряется.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`, `--pipeline-parallel-size`: перемножаются с PCP в `world_size`.
- `--decode-context-parallel-size`: при `pcp > 1` допустимы только значения `1`, `pcp` и `tp × pcp`.
- `--data-parallel-size`: запрещён вместе с `pcp > 1`.
- `--cp-kv-cache-interleave-size`: определяет гранулярность чередования KV-cache при context parallelism.
- `--enable-expert-parallel`: PCP входит множителем в `ep_size` и включает all2all-путь.
- `--max-model-len`, `--max-num-batched-tokens`: PCP имеет смысл ровно там, где длина запроса делает prefill долгим.

## Типовые проблемы и диагностика

- **Симптом:** `PCP does not support data parallelism yet.` **Лечение:** убрать `--data-parallel-size` или PCP.
- **Симптом:** `When PCP is enabled, DCP must be disabled, span the PCP axis, or span the full TP x PCP axis. Got TP=8, PCP=2, DCP=4; valid DCP sizes are [1, 2, 16].` **Лечение:** выбрать DCP из перечисленных.
- **Симптом:** `Prefill context parallelism requires Model Runner V2. Remove VLLM_USE_V2_MODEL_RUNNER=0.` **Причина:** V2 отключён переменной окружения.
- **Симптом:** в списке неподдерживаемого V2 значится `prefill context parallelism`. **Причина:** модель без MLA. **Лечение:** PCP на такой модели сегодня не применим.
- **Симптом:** `PCP not support hybrid attn now.` **Причина:** модель с разнородными attention-слоями.
- **Симптом:** мир процессов больше, чем карт: `World size (16) is larger than the number of available GPUs (8) in this node.` **Причина:** забыли, что PCP — множитель. **Лечение:** уменьшить произведение или добавить карты.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `prefill_context_parallel_size=N`; число worker-процессов равно `pp × tp × pcp`.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --tensor-parallel-size 8 --prefill-context-parallel-size 2 --max-model-len 131072
```

```bash
vllm serve /models/DeepSeek-V3 --tensor-parallel-size 8 --prefill-context-parallel-size 2 --decode-context-parallel-size 16 --max-model-len 131072
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/attention/selector.py`
- `vllm/vllm/v1/attention/backends/mla/indexer.py`
- `vllm/vllm/v1/core/kv_cache_coordinator.py`
- `vllm/vllm/v1/worker/block_table.py`
- `vllm/vllm/model_executor/layers/fused_moe/config.py`
- `vllm/docs/serving/context_parallel_deployment.md`
