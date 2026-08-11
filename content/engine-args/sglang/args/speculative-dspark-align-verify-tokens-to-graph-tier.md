---
schema: 1
engine: sglang
primaryName: "--speculative-dspark-align-verify-tokens-to-graph-tier"
title: "--speculative-dspark-align-verify-tokens-to-graph-tier"
summary: Добивает бюджет verify-токенов DSPARK до того размера, до которого forward и так дополняется паддингом (тир CUDA graph плюс кросс-ранговый максимум DP), превращая оплаченный паддинг в реальную проверку. Работает только в режиме `SGLANG_RAGGED_VERIFY_MODE=compact`.
group: spec
related:
  - --speculative-algorithm
  - --speculative-dspark-block-size
  - --speculative-dspark-sps-table-path
  - --speculative-dspark-confidence-sts-path
  - --speculative-num-draft-tokens
  - --cuda-graph-max-bs-decode
  - --enable-dp-attention
---

# --speculative-dspark-align-verify-tokens-to-graph-tier

## Кратко

В compact-режиме ragged-verify DSPARK проверяет у разных запросов разное число токенов, но forward всё равно дополняется до захваченного размера CUDA graph, а под DP-вниманием — ещё и до максимума по рангам. Этот паддинг оплачивается временем шага в любом случае. Флаг говорит планировщику: раз уж место оплачено, заполни его настоящими draft-токенами в порядке убывания confidence. Шаг стоит столько же, проверенных токенов становится больше. Выключен по умолчанию, и при выключенном расписание совпадает с прежним побайтово.

## Оригинальная справка

```text
DSPARK compact ragged-verify only. Fill the per-request verify lengths so the total verify-token count reaches the cuda-graph tier the forward is already padded to: round the dp-max scheduled total up to the captured token bucket and let the top-k allocator admit that many real draft tokens (confidence-ordered). This recovers the padding the forward pays for anyway -- both the cuda-graph bucket round-up and the dp cross-rank max -- turning it into extra real verification at the same step time. Off by default; when off the schedule is byte-for-byte unchanged.
```

## Паспорт аргумента

- Флаги: `--speculative-dspark-align-verify-tokens-to-graph-tier`
- Группа: `spec`
- Тип значения: bool (`action="store_true"`, парного `--no-…` нет)
- Допустимые значения: флаг присутствует — включено, отсутствует — выключено
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но становится no-op вне `SGLANG_RAGGED_VERIFY_MODE=compact` — на старте печатается предупреждение с фактическим значением режима
- Где объявлен: `ServerArgs.speculative_dspark_align_verify_tokens_to_graph_tier`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, алгоритмо-специфичный: читатели — `_handle_dspark` (проверка режима) и `DSparkVerifyPlanner`
- Этап применения: `__post_init__` (предупреждение) → каждый спекулятивный раунд при расчёте бюджета verify

## Что меняет в движке

Точка приложения одна — `DSparkVerifyPlanner._budget_aligned_to_graph_tier`. При выключенном флаге метод возвращает бюджет без изменений (отсюда формулировка «byte-for-byte unchanged»). При включённом:

1. берётся число запросов тира (локальное либо согласованное по DP-рангам);
2. считается «пол» тира по токенам (`verify_layout_graph_num_tokens_floor`) с учётом кросс-рангового максимума;
3. значение округляется вверх до захваченного размера графа (`round_up_grid` по `ragged_capture_num_tokens`);
4. `graph_tier_fill_budget` превращает этот размер в бюджет top-k: `min(graph_num_tokens, bs × verify_num_draft_tokens) − bs × min_verify_len`, то есть добавка ограничена сверху числом реально предложенных draft-токенов — из воздуха токены не берутся.

Дальше расширенный бюджет уходит в тот же `ScheduleVerifyLensTopk`, который раздаёт длины по убыванию confidence. Раскладка самого layout'а не трогается: она считается из тех же входов и совпадает по построению.

Условия, при которых механизм вообще существует: `SGLANG_RAGGED_VERIFY_MODE=compact` (по умолчанию `static`), наличие confidence-головы у draft-чекпоинта и включённый `SGLANG_PREP_IN_CUDA_GRAPH` — без последнего compact-режим отказывается запускаться, чтобы не выносить host-чтения на критический путь.

## Значения и формат

- Булев флаг без значения.
- В режимах `static` и `cap-accept` — no-op с предупреждением на старте.
- Верхняя граница добавки — `bs × (gamma + 1)`: больше, чем предложено draft'ом, проверить нельзя.
- Никакой связи с точностью выборки: verify остаётся точным, меняется только число проверяемых позиций.

## Когда использовать

- Уже включён compact-режим ragged-verify, подключена таблица SPS, и в метриках виден заметный разрыв между запланированными и оплаченными токенами (округление до тира графа, разброс между DP-рангами).
- Конфигурация с DP-вниманием, где кросс-ранговый максимум систематически больше локального: именно этот паддинг флаг и возвращает.
- Не включать в режиме `static` (значение по умолчанию): ничего не изменится, кроме предупреждения в логе.
- Не рассматривать как способ «ускорить DSPARK вообще»: выигрыш ограничен размером паддинга и появляется только там, где он реально есть.

## Влияние на производительность и память

- VRAM: не растёт. Тир CUDA graph и резерв KV на шаг уже посчитаны по худшему случаю `gamma + 1` токенов на запрос — флаг лишь наполняет уже оплаченную ширину.
- Время шага: по замыслу не меняется, потому что forward всё равно шёл по тому же тиру графа.
- Throughput: растёт настолько, насколько дополнительные проверенные токены оказываются принятыми; это видно как рост `accept len` при неизменной частоте шагов.
- Риск: при заметном разбросе длин запросов часть добавленных токенов будет отвергаться — вреда, кроме нулевого выигрыша, это не приносит.

## Взаимодействие с другими аргументами

- `--speculative-algorithm DSPARK`: единственный алгоритм, где флаг читается.
- `--speculative-dspark-sps-table-path`: без профилированной таблицы стоимости compact-режим вырождается в «проверять всё», и добивать до тира становится нечего.
- `--speculative-dspark-confidence-sts-path`: калибровка того же confidence-порядка, по которому раздаются добавленные токены.
- `--speculative-dspark-block-size` / `--speculative-num-draft-tokens`: задают потолок добавки (`bs × (gamma + 1)`).
- `--cuda-graph-max-bs-decode` и `--disable-cuda-graph`: определяют сетку захваченных тиров; без графов округлять не к чему, и метод возвращает исходный бюджет.
- `--enable-dp-attention`: включает вторую составляющую паддинга — кросс-ранговый максимум.
- Переменные окружения (не CLI): `SGLANG_RAGGED_VERIFY_MODE`, `SGLANG_PREP_IN_CUDA_GRAPH`.

## Типовые проблемы и диагностика

- `--speculative-dspark-align-verify-tokens-to-graph-tier only takes effect with SGLANG_RAGGED_VERIFY_MODE=compact (got 'static'); it will be a no-op.` — самая частая ситуация: включили флаг, не включив режим.
- `--speculative-dspark-sps-table-path feeds the ragged-verify budget scheduler, which is off under SGLANG_RAGGED_VERIFY_MODE=static; it will be a no-op.` — соседнее предупреждение того же хука, обычно приходит вместе.
- `DSpark ragged-verify mode 'compact' … this DSpark draft checkpoint has no confidence head` — режим не запустится, а с ним и флаг.
- `… requires SGLANG_PREP_IN_CUDA_GRAPH=1 (the captured-graph prepare path)` — compact-режим отказался стартовать.
- Включили, `accept len` не изменился — паддинга, который можно было бы вернуть, в вашей нагрузке нет; смотрите отладочный вывод планировщика (`SGLANG_DSPARK_DEBUG_CONFIDENCE_PREFIX_SCHEDULER=1`) и строки `Decode batch, …, accept len: …`.

## Примеры

```bash
SGLANG_RAGGED_VERIFY_MODE=compact SGLANG_PREP_IN_CUDA_GRAPH=1 python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-dspark-block-size 7 --speculative-dspark-sps-table-path /etc/arriero/dspark-sps.json --speculative-dspark-align-verify-tokens-to-graph-tier
```

```bash
SGLANG_RAGGED_VERIFY_MODE=compact SGLANG_PREP_IN_CUDA_GRAPH=1 python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-dspark-block-size 7 --speculative-dspark-sps-table-path /etc/arriero/dspark-sps.json --speculative-dspark-confidence-sts-path /etc/arriero/dspark-sts-gamma7.json --speculative-dspark-align-verify-tokens-to-graph-tier --cuda-graph-max-bs-decode 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_planner.py`
- `sglang/python/sglang/srt/speculative/ragged_verify.py`
- `sglang/python/sglang/srt/environ.py`
