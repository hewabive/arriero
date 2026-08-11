---
schema: 1
engine: sglang
primaryName: "--max-mamba-cache-size"
title: "--max-mamba-cache-size"
summary: Явное число слотов пула рекуррентных состояний гибридной модели. Перекрывает `--mamba-full-memory-ratio`; задается в слотах, а не в запросах — на один запрос уходит от 1 до 5 слотов.
group: schedule
related:
  - --mamba-full-memory-ratio
  - --max-running-requests
  - --disable-radix-cache
  - --mamba-ssm-dtype
  - --mamba-radix-cache-strategy
  - --disable-overlap-schedule
  - --mem-fraction-static
  - --speculative-num-draft-tokens
---

# --max-mamba-cache-size

## Кратко

Гибридные модели (mamba2, GDN, Kimi Linear, lightning-attention и остальные линейные архитектуры) хранят рекуррентные состояния в отдельном пуле фиксированных слотов. `--max-mamba-cache-size` задает число этих слотов напрямую, вместо вывода из отношения `--mamba-full-memory-ratio`. Главная ловушка — единица измерения: это **слоты**, а не одновременные запросы. Один запрос занимает от 1 до 5 слотов в зависимости от того, включен ли radix-кеш для mamba и работает ли overlap-планировщик.

## Оригинальная справка

```text
The maximum size of the mamba cache.
```

## Паспорт аргумента

- Флаги: `--max-mamba-cache-size`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: положительное целое; проверок в argparse нет
- Значение по умолчанию: `null` — размер выводится из памяти
- Эффективное значение: заданное значение делится на число attention-DP рангов (`max_mamba_cache_size // attn_dp_size`); при незаданном значении подставляется результат решения бюджетной задачи по `--mamba-full-memory-ratio`, а при `--disable-radix-cache` вместе с явным `--max-running-requests` — само число запросов на ранг
- Где объявлен: `ServerArgs.max_mamba_cache_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: выделение памяти под пулы (`KVCacheConfigurator._handle_max_mamba_cache`), до расчета KV-пула

## Что меняет в движке

`_handle_max_mamba_cache` выбирает одну из трех веток; заданное значение включает первую:

1. `--max-mamba-cache-size` задан → размер пула равен `значение // attn_dp_size`. Ни память, ни `--mamba-full-memory-ratio` не учитываются: сколько сказали, столько и будет выделено, а остаток бюджета уйдет в KV-пул.
2. Не задан, но заданы `--disable-radix-cache` и `--max-running-requests` → размер равен `max_running_requests // attn_dp_size` (при отключенном radix-кеше на запрос нужен ровно один слот).
3. Иначе → решается бюджетная задача по `--mamba-full-memory-ratio`.

Во всех ветках при спекулятивном декодировании из общего бюджета дополнительно вычитается промежуточный буфер размером `per_req × (капнутое число запросов + 1) × speculative_num_draft_tokens`. Затем результат проверяется: непозитивный размер — `RuntimeError` с перечнем действий.

Перевод слотов в запросы делает `resolve_max_num_reqs`:

```python
ratio = _calculate_mamba_ratio()          # 1 при --disable-radix-cache
mamba_cap = max_mamba_cache_size // ratio
max_num_reqs = min(max_num_reqs, mamba_cap)
```

`ratio` считается так: базово 3; минус 1 при `SGLANG_OPT_MAMBA_SKIP_DECODE_LOCK`; плюс 2 при стратегии `extra_buffer` с overlap-планировщиком, плюс 1 в «ленивом» варианте `extra_buffer_lazy` и плюс 1 при `extra_buffer` без overlap. Итог — от 3 до 5 слотов на запрос при включенном radix-кеше и ровно 1 при выключенном.

Фактически выделяется `max_mamba_cache_size + 1` слот: один слот пула — служебный padding.

## Значения и формат

- Целое число слотов; суффиксы SI/IEC не поддерживаются.
- Значение — суммарное по attention-DP рангам, делится на их число.
- `0` и отрицательные значения приводят к `RuntimeError: Not enough GPU memory for hybrid (mamba/linear-attention) state cache.` — проверка стоит после всех веток.
- Чтобы получить N одновременных запросов при включенном radix-кеше, задавайте не менее `N × ratio`; точное значение `ratio` печатается в предупреждении о срезании конкурентности.
- На не-гибридных моделях значение принимается и не используется.

## Когда использовать

- Когда нужен воспроизводимый размер пула состояний независимо от объема карты и от размера весов — например, чтобы сравнивать замеры между машинами.
- Когда бюджетное решение по `--mamba-full-memory-ratio` дает не тот баланс, а подбирать отношение неудобно: проще назвать число слотов.
- Когда известен целевой уровень конкурентности: задайте `--max-mamba-cache-size` равным `желаемое число запросов × ratio` и проверьте по логу, что срезания не произошло.
- Не задавайте «с запасом»: лишние слоты — это память, отнятая у KV-пула, и она не возвращается.
- Не используйте вместо `--max-running-requests`: этот аргумент не ограничивает конкурентность напрямую, он лишь задает верхнюю границу через деление на `ratio`.

## Влияние на производительность и память

- VRAM: линейно — `(значение + 1) × размер слота`. Размер слота зависит от архитектуры, числа mamba-слоев на ранге и `--mamba-ssm-dtype`.
- RAM хоста: не влияет.
- Время старта: не влияет.
- Throughput: слишком маленький пул срезает конкурентность; слишком большой отбирает память у KV-пула и приближает ретракты.
- Latency: прямого влияния нет.

## Взаимодействие с другими аргументами

- `--mamba-full-memory-ratio`: перекрывается этим аргументом полностью.
- `--max-running-requests`: срезается до `max_mamba_cache_size // ratio`; при `--disable-radix-cache` без явного размера пула, наоборот, сам определяет размер пула.
- `--disable-radix-cache`: делает `ratio` равным 1, то есть один слот на запрос.
- `--mamba-radix-cache-strategy`, `--disable-overlap-schedule`: определяют `ratio` в диапазоне 3…5.
- `--mamba-ssm-dtype bfloat16`: вдвое уменьшает размер слота — то же число слотов стоит вдвое дешевле.
- `--mem-fraction-static`: задает общий бюджет; явный размер пула вычитается из него первым, KV-пулу достается остаток.
- `--speculative-num-draft-tokens`: добавляет промежуточный буфер, пропорциональный числу draft-токенов.

## Типовые проблемы и диагностика

- `RuntimeError: Not enough GPU memory for hybrid (mamba/linear-attention) state cache. Computed max_mamba_cache_size=…` — заданное значение (после деления на DP-ранги) непозитивно либо памяти не хватает; сообщение перечисляет действия: уменьшить `--max-running-requests`, увеличить `--mem-fraction-static`, уменьшить `--speculative-num-draft-tokens`.
- `RuntimeError: Hybrid (mamba/linear-attention) state cache is too small to serve any requests. max_mamba_cache_size=…, mamba_ratio=…` — слотов меньше, чем нужно на один запрос; увеличивайте значение как минимум до `ratio`.
- `max_running_requests is capped to N by the mamba state cache (max_mamba_cache_size=M, K state slots per request).` — из этой строки читаются оба числа: и размер пула, и `ratio`.
- Ожидали N одновременных запросов, получили N/3 или N/5 — забыли умножить на `ratio`.
- Изменение `--mamba-full-memory-ratio` не действует — этот аргумент задан и перекрывает его.
- Принятое значение — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --max-mamba-cache-size 256
```

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --max-mamba-cache-size 64 --disable-radix-cache --max-running-requests 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/runtime_context.py`
- `sglang/python/sglang/srt/configs/hybrid_arch.py`
