---
schema: 1
engine: vllm
primaryName: "--data-parallel-hybrid-lb"
title: "--data-parallel-hybrid-lb"
summary: Режим «API-сервер на каждом узле»: vLLM балансирует между локальными DP-рангами, внешний LB — между узлами. Задается на каждом узле вместе с `--data-parallel-size-local` и `--data-parallel-start-rank`.
group: ParallelConfig
related:
  - --data-parallel-size
  - --data-parallel-size-local
  - --data-parallel-start-rank
  - --data-parallel-external-lb
  - --data-parallel-rank
  - --data-parallel-multi-port-external-lb
  - --data-parallel-address
  - --data-parallel-rpc-port
  - --api-server-count
  - --headless
  - --enable-elastic-ep
---

# --data-parallel-hybrid-lb

## Кратко

Hybrid — промежуточный режим между internal и external LB. Каждый узел поднимает собственный API-сервер, который распределяет запросы **только между своими** DP-рангами; распределением между узлами занимается внешний балансировщик. Планирование остается локальным, межузловой трафик балансировки исчезает.

Флаг задается на каждом узле развертывания и требует, чтобы узел знал свою долю рангов: `--data-parallel-size-local` обязателен, `--data-parallel-start-rank` — практически обязателен. Карта режимов целиком — в `--data-parallel-size`.

## Оригинальная справка

```text
Whether to use "hybrid" DP LB mode. Applies only to online serving
and when data_parallel_size > 0. Enables running an AsyncLLM
and API server on a "per-node" basis where vLLM load balances
between local data parallel ranks, but an external LB balances
between vLLM nodes/replicas. Set explicitly in conjunction with
--data-parallel-start-rank.
```

## Паспорт аргумента

- Флаги: `--data-parallel-hybrid-lb`, `--no-data-parallel-hybrid-lb`, `-dph`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо `--no-...`; «не задан» = `False`
- Значение по умолчанию: `false`
- Эффективное значение: доопределяется в `create_engine_config` трижды — включается автоматически при ненулевом `--data-parallel-start-rank` в не-headless запуске; выключается, если `data_parallel_size_local == data_parallel_size` (все ранги на одном узле); при `data_parallel_size_local == 1` заменяется на external LB с предупреждением
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.data_parallel_hybrid_lb`
- Этап применения: разбор CLI → выбор режима LB в `vllm/entrypoints/cli/serve.py` → `create_engine_config` → запуск локальных движков и рукопожатие

## Что меняет в движке

- **API-серверы.** `--api-server-count` по умолчанию равен `--data-parallel-size-local`, в лог уходит `Defaulting api_server_count to data_parallel_size_local (%d) for hybrid LB mode.` Каждый узел слушает свой `--port`.
- **Область управления клиента.** `ParallelConfig.local_engines_only` истинно, поэтому фронтенд узла держит только локальные движки; внутренняя балансировка по running/waiting-очередям работает, но ограничена ими.
- **Рукопожатие.** Ранг 0 по-прежнему собирает все `dp_size` движков, но удаленные ранги в hybrid-режиме **не** headless: `remote_should_be_headless = not hybrid and not external`, и нарушение дает явную ошибку.
- **Ранги узла.** `data_parallel_rank = data_parallel_start_rank or inferred_data_parallel_rank`, локальные движки получают индексы `rank … rank + local − 1`.

Поле входит в `ignored_factors` `ParallelConfig.compute_hash()`.

## Значения и формат

- Булев переключатель без аргумента; `--no-data-parallel-hybrid-lb` возвращает `False`.
- Требует `--data-parallel-size-local`: без него `Invalid data-parallel launch options: --data-parallel-hybrid-lb requires --data-parallel-size-local. Set it to the number of data-parallel ranks on this node.`
- Осмыслен только при `--data-parallel-size-local ≥ 2` и `< --data-parallel-size`. За пределами этого диапазона движок сам переключит режим (в external или в internal).
- Несовместим с `--headless`: `assert not headless or not self.data_parallel_hybrid_lb`.

## Когда использовать

- Развертывание на нескольких узлах с несколькими рангами на узле, когда единый фронтенд головного узла уже не тянет, а полный external LB (эндпоинт на каждый ранг) не нужен.
- Когда внешний балансировщик умеет только «узел целиком», а внутри узла хочется, чтобы очередями занимался vLLM.
- Не нужен на одноузловом развертывании — там он все равно выключится.
- Не нужен, если на узел приходится один ранг: используйте external LB прямо.

## Влияние на производительность и память

VRAM не затрагивает. По сравнению с internal LB: меньше межузлового трафика управления и нет единой точки, где сходятся все HTTP-запросы. По сравнению с external LB: сохраняется учет очередей внутри узла, но внешний LB должен уметь распределять по узлам без знания их внутренней загрузки.

## Взаимодействие с другими аргументами

- `--data-parallel-size-local`: обязателен; при `1` режим схлопывается в external.
- `--data-parallel-start-rank`: задает смещение рангов узла и сам включает hybrid в не-headless запуске.
- `--data-parallel-external-lb` / `--data-parallel-rank`: взаимно исключены — `--data-parallel-hybrid-lb и --data-parallel-external-lb cannot be enabled together`.
- `--data-parallel-multi-port-external-lb`: тоже взаимно исключен.
- `--headless`: несовместим.
- `--api-server-count`: по умолчанию берется из `--data-parallel-size-local`; можно перекрыть.
- `--enable-elastic-ep`: несовместим (`Elastic EP is not compatible with data_parallel_external_lb or data_parallel_hybrid_lb.`).
- `--data-parallel-address`, `--data-parallel-rpc-port`: обязаны совпадать на всех узлах.

## Типовые проблемы и диагностика

- **Симптом:** `Invalid data-parallel launch options: --data-parallel-hybrid-lb requires --data-parallel-size-local.` **Лечение:** добавить локальный размер.
- **Симптом:** `AssertionError: data_parallel_hybrid_lb is not applicable in headless mode`. **Лечение:** на headless-узлах оставить только `--data-parallel-start-rank`.
- **Симптом:** предупреждение `data_parallel_hybrid_lb is not eligible when data_parallel_size_local = 1, autoswitch to data_parallel_external_lb.` **Причина:** один ранг на узел. **Действие:** штатный откат; `--api-server-count` станет 1.
- **Симптом:** `Remote engine N must not use --headless in external or hybrid dp lb mode`. **Причина:** соседний узел запущен headless. **Лечение:** снять `--headless` со всех узлов.
- **Симптом:** hybrid включился «сам» на одноузловом развертывании и ничего не изменил. **Причина:** при `data_parallel_size_local == data_parallel_size` режим принудительно выключается. **Действие:** это ожидаемо.
- **Подтверждение принятого значения:** строка `Defaulting api_server_count to data_parallel_size_local (%d) for hybrid LB mode.` и наличие HTTP-эндпоинта на каждом узле.

## Примеры

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 0 --data-parallel-hybrid-lb --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

```bash
vllm serve /models/DeepSeek-V2-Lite --data-parallel-size 4 --data-parallel-size-local 2 --data-parallel-start-rank 2 --data-parallel-hybrid-lb --data-parallel-address 10.99.48.128 --data-parallel-rpc-port 13345
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/v1/engine/utils.py`
- `vllm/docs/serving/data_parallel_deployment.md`
