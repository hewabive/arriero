---
schema: 1
engine: sglang
primaryName: "--max-running-requests"
title: "--max-running-requests"
summary: Потолок одновременно выполняемых запросов (running batch). Не задан — движок оценит его из размера KV-пула и длины контекста; при спекулятивном декодировании безусловно становится 48.
group: schedule
related:
  - --max-total-tokens
  - --max-queued-requests
  - --mem-fraction-static
  - --context-length
  - --chunked-prefill-size
  - --prefill-max-requests
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
  - --speculative-num-draft-tokens
  - --disable-radix-cache
  - --pp-size
  - --enable-dp-attention
---

# --max-running-requests

## Кратко

`--max-running-requests` ограничивает размер running batch — сколько запросов одновременно находится в декодировании. Это не только политика: значение определяет размер `req_to_token`-пула на GPU (`max_running_requests × context_len × 4` байта), а для гибридных mamba-моделей и hybrid-SWA — размеры соответствующих пулов состояний. Незаданное значение оценивается из посчитанного KV-пула, но у оценки есть жесткий потолок 4096 и жесткий пол 2048; спекулятивное декодирование перекрывает все это значением 48.

## Оригинальная справка

```text
The maximum number of running requests.
```

## Паспорт аргумента

- Флаги: `--max-running-requests`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: положительное целое; проверки на положительность в argparse нет
- Значение по умолчанию: `null` — вычисляется после выделения KV-пула
- Эффективное значение: `48` при любом включенном `--speculative-algorithm` (все хуки в `arg_groups/speculative_hook.py` пишут это с предупреждением `Max running requests is reset to 48 for speculative decoding`); иначе — `resolve_max_num_reqs` (см. ниже); дополнительно ограничивается mamba-пулом и повторным расчетом после захвата CUDA graph
- Где объявлен: `ServerArgs.max_running_requests`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (только спекулятивная подстановка) → выделение KV-пула (`KVCacheConfigurator.resolve_max_num_reqs`) → `Scheduler` (admission)

## Что меняет в движке

### Разрешение значения

`resolve_max_num_reqs(token_capacity)` вызывается уже после того, как посчитан `max_total_num_tokens`:

```python
estimated = int(token_capacity / model_config.context_len * 512)
estimated = max(min(estimated, 4096), 2048)
if max_running_requests is not None:
    requested_per_worker = max_running_requests // attn_dp_size
    max_num_reqs = min(requested_per_worker, token_capacity // 2)
else:
    max_num_reqs = min(estimated, token_capacity // 2)
```

Из этого следуют два неочевидных факта. Первый: заданное значение — **суммарное по всем DP-рангам**, оно делится на `attn_dp_size`. Второй: незаданное значение никогда не выходит за пределы `[2048, 4096]`, каким бы ни был пул, — то есть «авто» почти всегда означает 2048…4096, и реальным ограничителем становится память, а не счетчик.

Для гибридных (mamba / linear-attention) моделей поверх этого накладывается `max_mamba_cache_size // ratio`, где `ratio` — число слотов состояния на запрос (3 по умолчанию, до 5 с ping-pong буфером при overlap-планировщике). Срезание логируется отдельно: `max_running_requests is capped to N by the mamba state cache (...)`.

Если включено пост-захватное определение размера пула, значение пересчитывается еще раз под уменьшенный пул (`Post-capture KV sizing: max_running_requests X -> Y`).

### Что значение делает дальше

- `ReqToTokenPool(size=max_num_reqs, max_context_len=context_len + 4…)` — тензор `int32` на GPU. При 4096 запросов и контексте 65536 это 1 ГиБ VRAM, вычитаемых из того же бюджета, что и KV-пул.
- `pp_max_micro_batch_size` по умолчанию = `max_running_requests // pp_size`, а `get_num_allocatable_reqs(running_bs) = pp_max_micro_batch_size − running_bs`, ограниченный сверху свободными слотами `req_to_token_pool`. Это и есть точка, где planner перестает добавлять запросы и ставит `batch_is_full`.
- `SWAChunkCapPoolConfigurator` включается только когда `max_running_requests` задан **явно** вместе с `--disable-radix-cache` и `--chunked-prefill-size` на hybrid-SWA модели: тогда SWA-пул считается по худшему случаю на запрос, а высвобожденная память уходит в full-пул.
- В `--disaggregation-mode decode` значение участвует в оценке активаций при автоподборе `--mem-fraction-static`.
- В arriero положительное значение читает `parseInstanceConcurrencyLimit` (`sglang-max-running-requests`) и превращает его в предел числа одновременных lease-держателей на этот target; отсутствие значения означает «менеджер не ограничивает, решает SGLang» (`docs/ENGINE_ADAPTERS.md`).

## Значения и формат

- Целое число запросов, суффиксы не поддерживаются.
- Значение больше, чем позволяет пул, молча срезается до `token_capacity // 2` с предупреждением `max_running_requests was reduced from the requested N to M (per dp worker) due to the available KV cache capacity.`
- Значения `0` и отрицательные argparse принимает; результат — неработающая admission-логика, а для гибридных моделей — `RuntimeError` про пустой mamba-кеш. Не используйте.
- Специального значения «без ограничения» нет: не задавать аргумент — это не «безлимит», а оценка из пула, ограниченная 4096.

## Когда использовать

- Задавайте явно, когда важна предсказуемость latency: 4096 «разрешенных» запросов при реальном пуле на 30 одновременных длинных генераций означают, что запросы будут приняты и потом ретрактнуты, а не подождут в очереди.
- Задавайте явно на гибридных SWA-моделях вместе с `--disable-radix-cache`, чтобы включился режим точного расчета SWA-пула по кэпу.
- Задавайте явно в arriero для KT-инстансов: это единственный источник для менеджерского предела конкурентности на target, и именно эту границу требует проверить квалификационный прогон (`docs/KTRANSFORMERS_OPERATIONS.md`).
- Понижайте, когда OOM приходит на decode-фазе: апстрим прямо рекомендует этот шаг раньше, чем правку `--mem-fraction-static`.
- Не поднимайте ради throughput, если `token usage` уже около 0.9: узкое место — KV-пул, а не счетчик, и рост значения даст только ретракты.
- Не путайте с `--max-queued-requests`: этот аргумент про одновременно считаемые запросы, тот — про длину очереди ожидания.

## Влияние на производительность и память

- VRAM: `req_to_token`-пул растет линейно по значению и по `--context-length`; на гибридных моделях линейно растет и пул mamba-состояний.
- RAM хоста: не влияет.
- Время старта: не влияет (кроме гибридных моделей, где от значения зависит решение задачи о размере mamba-пула).
- Throughput: до насыщения KV-пула растет с ростом значения; после — падает из-за ретрактов и роста накладных расходов планирования.
- Latency: чем больше running batch, тем выше время одного decode-шага; для интерактивной нагрузки предсказуемее небольшое явное значение.

## Взаимодействие с другими аргументами

- `--max-total-tokens` и `--mem-fraction-static`: задают `token_capacity`, от которого считается потолок `token_capacity // 2`.
- `--context-length`: делитель в оценке `token_capacity / context_len * 512` и множитель в размере `req_to_token`-пула.
- `--max-queued-requests`: следующий уровень — что происходит с запросами, которым не нашлось слота.
- `--prefill-max-requests`: отдельный лимит на число запросов именно в prefill-batch'е.
- `--speculative-algorithm` / `--speculative-num-draft-tokens`: любое спекулятивное декодирование ставит значение 48, если оно не задано; при гибридных моделях со спекуляцией значение обязано быть определено, иначе расчет mamba-пула падает на ассерте.
- `--max-mamba-cache-size`, `--mamba-full-memory-ratio`: верхняя граница для гибридных моделей.
- `--disable-radix-cache` + `--chunked-prefill-size`: вместе с явным значением включают точный расчет SWA-пула.
- `--pp-size`: делит значение на микробатчи (`pp_max_micro_batch_size`).
- `--enable-dp-attention` / `--dp-size`: значение делится на число attention-DP рангов.

## Типовые проблемы и диагностика

- Предупреждение `max_running_requests was reduced from the requested N to M` — запрошено больше, чем половина токенов пула. Либо увеличьте пул (`--mem-fraction-static`), либо примите M.
- `max_running_requests is capped to N by the mamba state cache` — упирается в mamba-пул; поднимайте `--mamba-full-memory-ratio` / `--max-mamba-cache-size` или уменьшайте состояние через `--mamba-ssm-dtype bfloat16`.
- `Max running requests is reset to 48 for speculative decoding` — ожидаемое поведение, а не ошибка; чтобы получить другое число, задайте аргумент явно.
- Постоянный `#queue-req` в сотнях при низком `token usage` — значение слишком мало для нагрузки; поднимайте.
- Частые `KV cache pool is full. Retract requests.` при большом значении — обратная ситуация: понижайте.
- Фактически принятое значение видно в сводке `max_total_num_tokens=…, max_running_requests=…, context_len=…` при готовности scheduler'а; исходное — в дампе `server_args=`. Различие между ними и есть результат всех срезаний.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-running-requests 32
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-running-requests 8 --max-queued-requests 64 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/kv_pool_runtime.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
- arriero: `docs/ENGINE_ADAPTERS.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
