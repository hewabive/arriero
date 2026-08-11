---
schema: 1
engine: sglang
primaryName: "--enable-cache-report"
title: "--enable-cache-report"
summary: Добавляет в `usage.prompt_tokens_details.cached_tokens` число токенов промпта, взятых из префиксного кеша. Единственный способ увидеть попадания radix cache на уровне ответа OpenAI API — без флага поле просто отсутствует.
group: serving
related:
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --stream-response-default-include-usage
  - --enable-metrics
  - --schedule-policy
---

# --enable-cache-report

## Кратко

SGLang всегда знает, сколько токенов промпта не пришлось считать заново — эта величина едет в `meta_info["cached_tokens"]` каждого ответа. Флаг только разрешает переложить ее в OpenAI-совместимое поле `usage.prompt_tokens_details.cached_tokens`.

Ничего в работе кеша он не меняет: это чистая телеметрия на уровне ответа.

## Оригинальная справка

```text
Return number of cached tokens in usage.prompt_tokens_details for each openai request.
```

## Паспорт аргумента

- Флаги: `--enable-cache-report`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет
- Где объявлен: `ServerArgs.enable_cache_report`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: HTTP-слой, сборка `usage` в ответе (`/v1/chat/completions`, `/v1/completions`, `/v1/responses`)

## Что меняет в движке

Источник данных — планировщик: он считает длину совпавшего префикса и кладет ее в `recv_obj.cached_tokens`, откуда `TokenizerManager._handle_batch_output` переносит в `meta_info["cached_tokens"]`. Это происходит **всегда**, независимо от флага.

Флаг читается в трех местах `UsageProcessor` (`sglang/python/sglang/srt/entrypoints/openai/usage_processor.py`):

- `calculate_response_usage` — нестриминговый ответ;
- `calculate_streaming_usage` — финальный usage-кадр стрима;
- `_continuous_usage_cached_details` в `serving_chat.py` — usage в каждом чанке при `stream_options.continuous_usage_stats`.

Во всех трех преобразование одно:

```python
def _details_if_cached(count: int) -> Optional[PromptTokensDetails]:
    """Return PromptTokensDetails only when count > 0 (keeps JSON slim)."""
    return PromptTokensDetails(cached_tokens=count) if count > 0 else None
```

Отсюда важное практическое следствие: **`prompt_tokens_details` отсутствует и при выключенном флаге, и при нулевом попадании кеша**. Различить «отчет выключен» и «кеш не попал» по одному ответу нельзя — нужен либо второй одинаковый запрос (второй обязан дать ненулевой `cached_tokens`), либо дамп `server_args=`.

При многовариантной генерации (`n > 1`) суммирование идет по одному ответу на промпт (`range(0, len(responses), n_choices)`), чтобы кешированные токены не умножались на число вариантов.

Отдельно от этого флага существует per-request поле `return_cached_tokens_details`: оно кладет разбивку по уровням кеша (device/host/storage) в расширение `sglext.cached_tokens_details` и работает независимо.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — поле `prompt_tokens_details` в ответах не появляется никогда.
- Единица — токены промпта. Значение не превышает `prompt_tokens`.
- Формат в ответе: `"usage": {"prompt_tokens": 1200, "completion_tokens": 64, "total_tokens": 1264, "prompt_tokens_details": {"cached_tokens": 1024}}`. Мультимодальные счетчики (`image_tokens`, `audio_tokens`, `video_tokens`) попадают в тот же объект, но добавляются независимо от флага.

## Когда использовать

- Нужно измерить реальную эффективность префиксного кеша под своей нагрузкой — это самый прямой способ, не требующий разбора логов планировщика.
- Клиент считает стоимость/экономию по кешированным токенам (агентские фреймворки это умеют).
- Диагностика: подозрение, что что-то в цепочке ломает общий префикс (сменившийся системный промпт, атрибуционные заголовки, нестабильный порядок tools).
- **Не включайте** ради ускорения — флаг ничего не ускоряет.
- **Не нужен**, если метрики и так снимаются через `--enable-metrics`: попадания кеша там тоже видны, но агрегированно, а не по запросам.

## Влияние на производительность и память

Практически нулевое: одна проверка и один маленький объект в JSON на ответ. На VRAM, KV-пул и скорость генерации не влияет. Ответ становится на несколько десятков байт длиннее.

## Взаимодействие с другими аргументами

- `--disable-radix-cache`: с ним `cached_tokens` всегда 0, а значит `prompt_tokens_details` не появится даже при включенном флаге.
- `--enable-hierarchical-cache`: попадания из host-уровня учитываются в том же `cached_tokens`; разбивку по уровням дает только per-request `return_cached_tokens_details`.
- `--schedule-policy lpm`: политика, которая целенаправленно повышает долю кешированных токенов; этот флаг — способ проверить, что она действительно работает.
- `--stream-response-default-include-usage`: в стриминге `usage` (а с ним и `cached_tokens`) вообще не придет, пока клиент не попросил usage или пока не включен этот флаг.

В arriero измеритель прокси читает `usage.prompt_tokens_details.cached_tokens` и записывает его в трассу запроса как `cacheReadTokens` (`proxy/usage-meter.ts`, `openaiCachedTokens`). Без `--enable-cache-report` у SGLang-инстанса это поле в трассах и в статистике `#/proxy/traces` будет всегда пустым — не потому что кеш не работает, а потому что сервер о нем не отчитывается. Для наблюдаемости arriero флаг практически обязателен.

## Типовые проблемы и диагностика

- **Флаг включен, `prompt_tokens_details` нет** — попадание кеша нулевое. Повторите тот же запрос второй раз подряд: на втором прогоне поле обязано появиться.
- **`cached_tokens` всегда 0 на повторяющихся запросах** — либо `--disable-radix-cache`, либо префикс каждый раз разный. У Claude Code типичная причина — атрибуционные заголовки, меняющие префикс; в arriero это лечится нодой `strip-attribution` в пайплайне.
- **В стриминге поля нет, в нестриминге есть** — клиент не запросил usage в стриме.
- Кросс-проверка со стороны сервера: в логе планировщика строки `Prefill batch, ... #cached-token: N` показывают ту же величину до попадания в HTTP-слой.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-cache-report --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-cache-report --stream-response-default-include-usage --schedule-policy lpm --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/openai/usage_processor.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
