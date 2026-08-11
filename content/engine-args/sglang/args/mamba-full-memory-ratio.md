---
schema: 1
engine: sglang
primaryName: "--mamba-full-memory-ratio"
title: "--mamba-full-memory-ratio"
summary: Делит бюджет памяти гибридной модели между пулом mamba-состояний и KV-пулом полноконтекстных слоев. Читается только когда не заданы `--max-mamba-cache-size` и связка `--disable-radix-cache` + `--max-running-requests`.
group: schedule
related:
  - --max-mamba-cache-size
  - --max-running-requests
  - --mem-fraction-static
  - --disable-radix-cache
  - --mamba-ssm-dtype
  - --mamba-radix-cache-strategy
  - --disable-overlap-schedule
  - --speculative-num-draft-tokens
---

# --mamba-full-memory-ratio

## Кратко

У гибридных моделей (mamba2, GDN, Kimi Linear, lightning-attention и прочие линейные архитектуры из реестра) память после весов делится на две части: пул рекуррентных состояний и обычный KV-пул полноконтекстных слоев. `--mamba-full-memory-ratio` задает отношение первого ко второму. Значение `0.9` по умолчанию означает, что состояниям достается `0.9/1.9 ≈ 47%` бюджета. На не-гибридных моделях аргумент не читается вовсе.

## Оригинальная справка

```text
The ratio of mamba state memory to full kv cache memory.
```

## Паспорт аргумента

- Флаги: `--mamba-full-memory-ratio`
- Группа: `schedule`
- Тип значения: float
- Допустимые значения: положительное число; argparse ограничений не накладывает. Это отношение, а не доля, поэтому значения больше 1 корректны и означают «состояниям больше, чем KV»
- Значение по умолчанию: `0.9`
- Эффективное значение: не переопределяется автоматикой, но полностью игнорируется, если задан `--max-mamba-cache-size` либо одновременно заданы `--disable-radix-cache` и `--max-running-requests`
- Где объявлен: `ServerArgs.mamba_full_memory_ratio`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: выделение памяти под пулы (`KVCacheConfigurator._handle_max_mamba_cache`), до расчета KV-пула

## Что меняет в движке

`_handle_max_mamba_cache(total_rest_memory)` вызывается сразу после вычета slack по `--mem-fraction-static` и до расчета KV-пула. Значение используется только в третьей ветке — когда размер пула состояний нужно вывести из памяти:

```python
mamba_budget = total_rest_memory * mamba_full_memory_ratio / (1 + mamba_full_memory_ratio)
max_mamba_cache_size = int((mamba_budget_bytes - per_slot) // per_slot)
```

`per_slot` — байты одного слота состояния на запрос (плюс кольцевой буфер ReplaySSM, если он активен), масштабированные под долю слоев текущего PP-ранга. При спекулятивном декодировании задача решается совместно: в бюджет включается и промежуточный буфер на `speculative_num_draft_tokens`.

После этого из `total_rest_memory` вычитается фактически занятая состояниями память, и остаток уходит в KV-пул. То есть отношение работает не как жесткая квота, а как способ выбрать `max_mamba_cache_size`; итоговое деление близко к заданному, но округляется по размеру слота.

Полученный `max_mamba_cache_size` затем ограничивает конкурентность: `resolve_max_num_reqs` берет `max_mamba_cache_size // ratio`, где `ratio` — число слотов состояния на один запрос (3 базово; +2 с ping-pong буфером extra_buffer при overlap-планировщике, +1 в «ленивом» варианте и без overlap; `1` при `--disable-radix-cache`).

## Значения и формат

- Дробное число. `--mamba-full-memory-ratio 1.0` делит бюджет пополам, `0.5` отдает состояниям треть, `2.0` — две трети.
- Значение `0` argparse примет, но тогда `mamba_budget` равен нулю, `max_mamba_cache_size` получится отрицательным, и старт падает с `RuntimeError: Not enough GPU memory for hybrid (mamba/linear-attention) state cache.`
- Отдельного «авто» нет; сам аргумент и есть автоматический режим относительно двух явных.
- На не-гибридных моделях значение принимается и молча не используется.

## Когда использовать

- Когда нагрузка — много коротких параллельных запросов: состояний нужно больше, поднимайте отношение и получайте больше слотов.
- Когда нагрузка — мало длинных запросов с общими префиксами: KV-пул важнее, опускайте отношение (например до 0.4–0.6), чтобы radix-кеш держал больше токенов.
- Когда в логе видно `max_running_requests is capped to N by the mamba state cache` и хочется поднять потолок конкурентности, не трогая `--mem-fraction-static`.
- Не используйте вместе с `--max-mamba-cache-size`: последний полностью перекрывает отношение.
- Не используйте на не-гибридной модели: ничего не изменится.

## Влияние на производительность и память

- VRAM: перераспределяет уже выделенный бюджет между двумя пулами, суммарный расход не меняет.
- RAM хоста: не влияет.
- Время старта: не влияет (расчет аналитический, без пробных аллокаций).
- Throughput: зависит от профиля. Слишком мало состояний — низкий потолок конкурентности; слишком мало KV — ранние ретракты и потери префикс-кеша.
- Latency: прямого влияния нет.

## Взаимодействие с другими аргументами

- `--max-mamba-cache-size`: явный размер пула состояний, полностью перекрывает отношение.
- `--disable-radix-cache` + `--max-running-requests`: вторая перекрывающая комбинация — размер пула берется равным числу запросов на DP-ранг.
- `--max-running-requests`: сверху ограничивается `max_mamba_cache_size // ratio`.
- `--mem-fraction-static`: задает общий бюджет, который делится этим отношением.
- `--mamba-ssm-dtype`: `bfloat16` вдвое уменьшает размер одного слота, то есть при том же отношении дает вдвое больше слотов.
- `--mamba-radix-cache-strategy` и `--disable-overlap-schedule`: определяют число слотов на запрос (`ratio`), то есть перевод «слотов» в «запросы».
- `--speculative-num-draft-tokens`: добавляет промежуточный буфер в тот же бюджет.

## Типовые проблемы и диагностика

- `RuntimeError: Not enough GPU memory for hybrid (mamba/linear-attention) state cache. Computed max_mamba_cache_size=… (total_rest_memory=… GB, mamba_cache_per_req=… MB).` — бюджета не хватает даже на один слот; поднимайте отношение либо `--mem-fraction-static`.
- `max_running_requests is capped to N by the mamba state cache (max_mamba_cache_size=…, K state slots per request).` — сообщение прямо называет и текущий размер пула, и число слотов на запрос; из них видно, во что превратилось отношение.
- KV-пул неожиданно мал на гибридной модели — состояния съели бюджет; уменьшайте отношение.
- Изменение отношения ничего не дало — проверьте, не заданы ли `--max-mamba-cache-size` или пара `--disable-radix-cache` + `--max-running-requests`.
- Принятое значение — в дампе `server_args=`; результат — в сообщении о срезании конкурентности и в сводке `max_total_num_tokens=…`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-full-memory-ratio 1.5
```

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-full-memory-ratio 0.5 --mamba-ssm-dtype bfloat16 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/configs/hybrid_arch.py`
- `sglang/python/sglang/srt/runtime_context.py`
