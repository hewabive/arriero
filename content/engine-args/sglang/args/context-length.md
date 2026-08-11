---
schema: 1
engine: sglang
primaryName: "--context-length"
title: "--context-length"
summary: Максимальная длина контекста модели. Не задан — берется из HF-конфига; задан больше выведенного — старт падает, пока не выставлен SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1. Размер KV-пула этим аргументом не управляется.
group: model
related:
  - --max-total-tokens
  - --mem-fraction-static
  - --page-size
  - --chunked-prefill-size
  - --max-running-requests
  - --allow-auto-truncate
  - --json-model-override-args
  - --max-prefill-tokens
---

# --context-length

## Кратко

`--context-length` задает `ModelConfig.context_len` — потолок длины одной последовательности. Он **не** резервирует память и **не** увеличивает KV-пул: пул считается из свободной VRAM через `--mem-fraction-static`, а `--context-length` только ограничивает, сколько токенов может занять один запрос, и определяет ширину строки в `req_to_token`-пуле. Если пул меньше запрошенного контекста, сервер спокойно стартует, но фактический лимит на запрос становится равен размеру пула. Если запрошенный контекст больше того, что выводится из `config.json`, старт падает с `ValueError` — это защита, а не предупреждение.

## Оригинальная справка

```text
The model's maximum context length. Defaults to None (will use the value from the model's config.json instead).

Supports standard SI suffixes (k, M, G, T) and IEC suffixes
(Ki, Mi, Gi, Ti). Suffixes are case-sensitive.

Decimals are allowed for SI suffixes only.

Examples:
    '1k' -> 1000      '1M' -> 1000000    '25.6k' -> 25600
    '1Ki' -> 1024     '1Mi' -> 1048576
```

## Паспорт аргумента

- Флаги: `--context-length`
- Группа: `model`
- Тип значения: целое (`Optional[int]`), разбирается парсером `human_readable_int`
- Допустимые значения: целое число либо число с суффиксом SI (`k`, `M`, `G`, `T`) / IEC (`Ki`, `Mi`, `Gi`, `Ti`); регистр суффикса значим, дробные допустимы только с SI
- Значение по умолчанию: `null` — «взять из конфига модели»
- Эффективное значение: `ModelConfig._derive_context_length` подставляет `get_context_length(hf_text_config)`, если аргумент не задан; отдельно на AMD при `attention_backend == "aiter"` и `context_len > 8192` движок домножает `mem_fraction_static` на `0.85`
- Где объявлен: `ServerArgs.context_length`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → построение `ModelConfig` (до выделения памяти) → выделение `req_to_token`-пула → расчет `max_req_len` в `tp_worker` → валидация каждого входящего запроса

## Что меняет в движке

### Что берется из HF-конфига, когда аргумент не задан

`get_context_length(config)` (`sglang/python/sglang/srt/utils/hf_transformers/common.py`) идет по списку ключей **в этом порядке** и берет первый непустой:

```text
max_sequence_length → seq_length → max_seq_len → model_max_length → max_position_embeddings
```

Если ни одного нет — возвращается `2048`. Найденное значение домножается на `rope_scaling["factor"]`, но множитель принудительно сбрасывается в `1`, если в `rope_scaling` есть `original_max_position_embeddings` либо если `rope_type == "llama3"`. Отсюда два практических следствия: во-первых, «выведенная» длина может не совпадать с `max_position_embeddings` из конфига (для YaRN она в `factor` раз больше); во-вторых, у моделей, где `rope_scaling` описан через `original_max_position_embeddings`, автоматического расширения не происходит вовсе.

### Что происходит, когда значение задано

`_derive_context_length` (`sglang/python/sglang/srt/configs/model_config.py`):

- значение ≤ выведенного — просто присваивается `self.context_len`;
- значение > выведенного — печатается «Warning: User-specified context_length (N) is greater than the derived context_length (M). This may lead to incorrect model outputs or CUDA errors.» и **бросается `ValueError`** с подсказкой `To allow overriding this maximum, set the env var SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1`. Только с этой переменной окружения (или в CI) предупреждение остается предупреждением, а значение принимается.

Итог кладется и в `hf_config.context_len`, чтобы код моделей мог его прочитать.

### Что происходит, когда контекст не влезает в KV-пул

Размер пула считается независимо: `max_total_num_tokens = available_bytes // cell_size`, где `available_bytes` — остаток VRAM после весов по `--mem-fraction-static`, а `cell_size` — байт на токен (зависит от архитектуры, числа слоев, `--kv-cache-dtype`, `--tp-size`). `--context-length` в этот расчет не входит совсем. Пул затем выравнивается вниз до целого числа страниц `--page-size`, и `--max-total-tokens` может опустить его еще ниже.

Связь появляется позже, в `tp_worker.get_worker_info`:

```python
max_req_len = min(
    self.model_config.context_len - 1,
    self.model_runner.effective_max_total_num_tokens * self.ps.attn_dcp_size - 1,
)
...
max_req_input_len = max_req_len - 5
```

То есть **эффективный лимит на запрос — минимум из контекста и всего KV-пула**. Запрошенные 1M токенов при пуле на 200k дают `max_req_len ≈ 200k`, и сервер об этом отдельно не предупреждает — он стартует, а отказ приходит на конкретном запросе. Если пул совсем мал, срабатывает `assert max_req_len > 0, "Memory pool size is too small"` при инициализации воркера.

Проверка запроса — `validate_input_length` (`sglang/python/sglang/srt/managers/utils.py`): при `len(origin_input_ids) >= max_req_input_len` без `--allow-auto-truncate` возвращается ошибка `Input length (N tokens) exceeds the maximum allowed length (M tokens). Use a shorter input or enable --allow-auto-truncate.`, а с ним — вход молча обрезается с предупреждением «Request length is longer than the KV cache pool size or the max context length. Truncated.»

## Значения и формат

- `--context-length 131072`, `--context-length 128Ki` и `--context-length 131.072k` дают одно и то же число.
- Суффиксы **регистрозависимы**: `128K` (заглавная K) — не SI-килo и не IEC, парсер отвергнет строку с `Invalid integer value: '128K'. Use a plain integer, SI suffixes (1k, 1M), or IEC suffixes (1Ki, 1Mi). Suffixes are case-sensitive.`
- Дробь с IEC-суффиксом запрещена явно: `1.5Ki` → `Decimals are not allowed with IEC suffixes like 'Ki'.`
- `0` и отрицательные argparse примет, но дальше `max_req_len = context_len - 1` станет ≤ 0 и воркер упадет на ассерте «Memory pool size is too small». Значения «отключить» у этого аргумента нет.
- Единица измерения — токены, а не символы и не байты.

## Когда использовать

- **Уменьшать**, когда модель заявляет гигантский контекст, а вам нужен предсказуемый расход `req_to_token`-пула и понятный лимит запроса. Это самый частый осмысленный случай: 1M-контекстные модели на одной карте всё равно не обслужат 1M, и держать `context_len = 1M` — значит платить VRAM за строки `req_to_token` впустую.
- **Увеличивать** — только вместе с фактическим расширением RoPE через `--json-model-override-args` и переменной `SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1`. Апстрим-рецепты именно так и выглядят (см. `sglang/docs/cookbook/autoregressive/Qwen/Qwen3-Next.mdx`): сначала YaRN в override-аргументах, потом `--context-length`. Поднять число без изменения rope — получить «CUDA errors or incorrect outputs», о которых предупреждает сам код.
- **Не трогать**, если задача — увеличить количество одновременных запросов или размер кеша префиксов: за это отвечают `--mem-fraction-static`, `--max-total-tokens` и `--max-running-requests`.

## Влияние на производительность и память

- **`req_to_token`-пул**: `torch.zeros((max_running_requests + 1, context_len + extra), dtype=torch.int32)` на GPU, то есть **4 байта на каждую пару (слот запроса × токен контекста)**. При `context_len = 1_000_000` и 2048 слотах это ~8 ГиБ VRAM — чистые накладные расходы, не KV. `extra` — 4 плюс запас под спекулятивные draft-токены.
- **KV-пул**: не зависит от `--context-length` вообще.
- **Число слотов запросов**: `resolve_max_num_reqs` считает `estimated = token_capacity / context_len * 512`, но затем зажимает результат в диапазон `[2048, 4096]` и берет `min(estimated, token_capacity // 2)`. Практически контекст влияет на эту оценку только косвенно.
- **CUDA graph**: в embedding-режиме на Hopper/Blackwell `prefill.max_bs` поднимается до `max(prefill.max_bs, context_len, 16384)` — то есть большой контекст напрямую раздувает буферы prefill-графа.
- **AMD/aiter**: `context_len > 8192` уменьшает `mem_fraction_static` в 0.85 раза, то есть уменьшает и KV-пул.
- На latency сам по себе не влияет — влияет длина реальных запросов.

## Взаимодействие с другими аргументами

- `--mem-fraction-static`: определяет размер KV-пула. Именно он, а не `--context-length`, решает, сколько токенов сервер физически удержит. Задавать большой контекст без увеличения пула бессмысленно.
- `--max-total-tokens`: жесткий потолок пула сверху; если он ниже профилированного значения, движок пишет «max_total_tokens=… is larger than the profiled value …» только в обратном случае, а меньшее значение применяется молча и напрямую опускает `max_req_len`.
- `--page-size`: пул выравнивается вниз до целого числа страниц, поэтому фактический `max_total_num_tokens` (а значит и потолок запроса) может оказаться чуть меньше расчетного.
- `--chunked-prefill-size` / `--max-prefill-tokens`: определяют, как длинный prefill режется на куски; при большом контексте это единственный способ не упереться в активации.
- `--max-running-requests`: множитель для `req_to_token`-пула — произведение с `context_len` и дает его размер.
- `--allow-auto-truncate`: превращает отказ «Input length … exceeds …» в тихое усечение.
- `--json-model-override-args`: единственный способ реально изменить rope-конфигурацию под расширенный контекст.

В arriero KV-пул целиком лежит внутри объявленного memory draw инстанса (`docs/RESOURCE_MANAGEMENT.md`), поэтому `--context-length` не меняет заявленную резервацию — он меняет только то, что сервер согласится принять в одном запросе.

## Типовые проблемы и диагностика

- `ValueError: Warning: User-specified context_length (N) is greater than the derived context_length (M). … To allow overriding this maximum, set the env var SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1` — запрошено больше, чем дает конфиг. Правильный ответ почти всегда — не выставлять переменную, а поправить rope через `--json-model-override-args`.
- Запросы падают с `Input length (N tokens) exceeds the maximum allowed length (M tokens)`, где `M` заметно меньше заданного контекста — упёрлись в KV-пул, а не в контекст. Сравните `M + 5 + 1` с `max_total_num_tokens` из стартовой строки планировщика.
- `AssertionError: Memory pool size is too small` при инициализации воркера — пул выродился в ноль-с-небольшим относительно контекста; поднимайте `--mem-fraction-static` или снижайте контекст.
- `argparse.ArgumentTypeError: Invalid integer value: '128K'` — регистр суффикса.
- Что реально принято, подтверждают две строки: дамп `server_args=` при старте (значение аргумента) и строка планировщика `max_total_num_tokens=…, chunked_prefill_size=…, max_prefill_tokens=…, max_running_requests=…, context_len=…, available_gpu_mem=… GB` — там `context_len` уже итоговый, а `max_total_num_tokens` показывает реальный потолок.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --context-length 32Ki --mem-fraction-static 0.85 --page-size 64
```

```bash
SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1 python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --json-model-override-args '{"rope_scaling":{"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":262144}}' --context-length 1M
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/common.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/managers/utils.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/docs/cookbook/autoregressive/Qwen/Qwen3-Next.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
