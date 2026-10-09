---
schema: 1
engine: sglang
primaryName: "--swa-prefix-tails"
title: "--swa-prefix-tails"
summary: Для моделей семейства DeepSeek-V4, когда SWA-пул считается от лимита запросов (cap-режим, по умолчанию у DeepSeek-V4.1), — сколько хвостов закешированных префиксов (окно плюс страница каждый) пул держит сверх нужд работающих запросов. По умолчанию `4 × max_running_requests` на attention-DP rank, `0` при выключенном radix cache.
group: schedule
related:
  - --max-running-requests
  - --swa-full-tokens-ratio
  - --disable-radix-cache
  - --chunked-prefill-size
  - --page-size
  - --mem-fraction-static
  - --dp-size
---

# --swa-prefix-tails

## Кратко

У DeepSeek-V4 часть внимания — скользящее окно, и его KV лежит в отдельном SWA-пуле. Закешированный в radix-дереве префикс можно переиспользовать, только пока его последние `sliding_window` токенов еще занимают SWA-слоты. В cap-режиме SWA-пул считается не долей от full-пула, а «в обрез»: худший случай для `--max-running-requests` одновременных запросов плюс запас на `--swa-prefix-tails` таких хвостов. Аргумент задает этот запас. Больше хвостов — больше префиксов переживают завершение запросов, но меньше VRAM остается full-пулу. Аргумент новый в checkout'е; наличие в установленной сборке проверяйте по `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
When the SWA KV pool is sized from the request cap (DeepSeek-V4 family), how many radix-cached prefix tails it keeps room for. Each tail is one sliding window plus one page. Default: 4 x max_running_requests per attention-DP rank, 0 when the radix cache is disabled.
```

## Паспорт аргумента

- Флаги: `--swa-prefix-tails`
- Группа: `schedule`
- Тип значения: optional int
- Допустимые значения: целое `≥ 0`
- Значение по умолчанию: `null` — подбирается при расчете пулов
- Эффективное значение: `DSV4PoolConfigurator._resolve_swa_prefix_tails` (`model_executor/pool_configurator.py`) берет явное значение как есть; иначе `0` при `--disable-radix-cache`, иначе `4 × (max_running_requests // attn_dp_size)`. Значение используется, только если пул работает в cap-режиме (см. ниже)
- Где объявлен: `python/sglang/srt/arg_groups/fields/schedule.py:Schedule.swa_prefix_tails`
- Статус: обычный
- Этап применения: проверка `≥ 0` в `__post_init__` (`handle_cache_compatibility`, `arg_groups/kv_cache_hook.py`) → расчет размеров KV-пулов DeepSeek-V4 при инициализации model runner

## Что меняет в движке

Аргумент читает только `DSV4PoolConfigurator` — конфигуратор пулов семейства DeepSeek-V4. Он выбирает между двумя способами размера SWA-пула (`_resolve_swa_cap_tokens`):

- **ratio-режим** — `swa_tokens = full_tokens × swa_full_tokens_ratio`. Включается, если коэффициент к моменту проверки кеша задан (`_swa_full_tokens_ratio_explicitly_set`: учитывается и пользовательское значение, и модельное переопределение), если `--max-running-requests` неизвестен, если вне decode-режима chunked prefill выключен (`--chunked-prefill-size` не задан или `≤ 0`), а также в ring-режиме ROCm (`SGLANG_HACK_FLASHMLA_BACKEND=unified_kv_triton`). В ratio-режиме аргумент ни на что не влияет.
- **cap-режим** — во всех остальных случаях. Для `DeepseekV4ForCausalLM` `--max-running-requests` по умолчанию выставляется в `256` (`apply_deepseek_v4_defaults`). Модельное переопределение (`arg_groups/model_overrides/deepseek_v4.py`) ставит `swa_full_tokens_ratio = 0.1` всем чекпойнтам DeepSeek-V4, кроме DeepSeek-V4.1 (`model_type: deepseek_v41`), и это значение считается заданным. Итог: у DeepSeek-V4.1 cap-режим — путь по умолчанию, а DeepSeek-V4 остается в ratio-режиме с `0.1`, и аргумент на нем не действует.

В cap-режиме:

```text
swa_cap_tokens = ceil_align(request_cap + prefix_tails × (sliding_window + page_size), page_size)
```

где `request_cap` (`compute_swa_request_cap`) — худший случай живых SWA-слотов на attention-DP rank: на каждый запрос окно, интервал вытеснения `SGLANG_SWA_EVICTION_INTERVAL` (по умолчанию 128) с учетом draft-токенов, страница и место под decode-аллокацию, плюс один-два чанка prefill (на decode-сервере — дополнительные слоты `--disaggregation-decode-extra-slots`). SWA-пул и связанное с ним c4-состояние вычитаются из бюджета как фиксированные байты, а весь остаток уходит full-пулу. В лог идет `DSV4 SWA sizing: mode=cap, swa_tokens=…, request_cap+headroom=…, prefix_tails=…`.

При `--enable-encoder-swa-bounded-replay` без paged draft-слоев SWA-пул обнуляется целиком, и аргумент тоже не действует.

## Значения и формат

- Целое `≥ 0`; отрицательное — `ValueError: --swa-prefix-tails should be a non-negative integer.`
- `0` — SWA-пул только под работающие запросы: префиксы переживают завершение запроса, лишь пока их хвосты не вытеснены следующими запросами.
- Не задан — `4 × max_running_requests` на attention-DP rank (при `--max-running-requests 256` и без DP attention — `1024` хвоста), `0` при `--disable-radix-cache`.
- Один хвост стоит `sliding_window + page_size` SWA-токенов во всех слоях; итог выравнивается вверх по `--page-size`.

## Когда использовать

- Много повторяющихся длинных префиксов (агенты, общий системный промпт, многоходовые диалоги), а hit rate radix cache ниже ожидаемого: префиксы теряют SWA-хвосты раньше, чем приходит следующий запрос. Поднимите значение.
- Старт падает с `The DSV4 SWA pool cap … leaves no room for the full KV pool` или full-пул получается слишком маленьким: уменьшите значение (в том числе до `0`) или `--max-running-requests`.
- Не трогайте на моделях вне семейства DeepSeek-V4, на DeepSeek-V4 с `model_type`, отличным от `deepseek_v41`, и при явном `--swa-full-tokens-ratio`: там пул в ratio-режиме и аргумент не действует. Проверка — строка `DSV4 SWA sizing: mode=…` в логе.

## Влияние на производительность и память

- VRAM перераспределяется внутри того же бюджета KV-пула (`--mem-fraction-static`): каждый хвост — `sliding_window + page_size` SWA-токенов, отнятых у full-пула. Общий объем KV на GPU не меняется, меняется число full-токенов (`max_total_num_tokens`) и, значит, суммарная длина контекстов, которую можно держать.
- Prefix cache: больше хвостов — больше закешированных префиксов остаются переиспользуемыми, меньше повторного prefill.
- На скорость forward напрямую не влияет.

## Взаимодействие с другими аргументами

- `--max-running-requests`: база значения по умолчанию и основная часть `request_cap`; без него cap-режим не включается.
- `--swa-full-tokens-ratio`: явное значение (как и модельное `0.1` для DeepSeek-V4, кроме V4.1) переключает пул в ratio-режим, и этот аргумент перестает действовать.
- `--disable-radix-cache`: делает значение по умолчанию равным `0` — переиспользовать нечего.
- `--chunked-prefill-size`: вне decode-режима без chunked prefill cap-режим не включается; размер чанка входит в `request_cap`.
- `--page-size`: каждый хвост добавляет страницу, итог выравнивается по странице.
- `--dp-size` с DP attention: значение по умолчанию и `request_cap` считаются на attention-DP rank (`max_running_requests // attn_dp_size`).
- `--mem-fraction-static`: общий бюджет, который делят SWA- и full-пулы.

## Типовые проблемы и диагностика

- `ValueError: --swa-prefix-tails should be a non-negative integer.` — отрицательное значение.
- `RuntimeError: The DSV4 SWA pool cap (N tokens, X GB) leaves no room for the full KV pool within the available Y GB. Reduce --max-running-requests, lower --swa-prefix-tails or SGLANG_SWA_EVICTION_INTERVAL, or increase --mem-fraction-static.` — запас под хвосты вместе с `request_cap` съел весь бюджет.
- Какой режим выбран и сколько хвостов учтено — строка `DSV4 SWA sizing: mode=cap, …, prefix_tails=…` (в ratio-режиме — `mode=ratio (…)` без `prefix_tails`), рядом — `DSV4 memory calculation: …` с итоговыми размерами.
- Принятое значение (или `None`, если подбор отложен до расчета пулов) — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1 --tp-size 8 --max-running-requests 128 --swa-prefix-tails 1024
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1 --tp-size 8 --max-running-requests 256 --swa-prefix-tails 0
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/schedule.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/arg_groups/model_overrides/deepseek_v4.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/environ.py`
