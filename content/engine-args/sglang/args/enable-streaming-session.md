---
schema: 1
engine: sglang
primaryName: "--enable-streaming-session"
title: "--enable-streaming-session"
summary: Разрешает streaming-сессии нативного API: KV предыдущего хода удерживается в пуле между запросами одной сессии, а не возвращается в radix cache. Работает только через `/open_session` + `session_params` на `/generate`; OpenAI-эндпоинты его не используют.
group: serving
related:
  - --enable-session-radix-cache
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --enable-metrics
  - --max-running-requests
---

# --enable-streaming-session

## Кратко

Обычная сессия SGLang — это способ склеить несколько запросов в одну логическую цепочку, где следующий ход попадает в префиксный кеш от предыдущего. Streaming-сессия идет дальше: она **удерживает физические слоты KV-пула** за сессией между ходами, вместо того чтобы отдать их дереву префиксов и надеяться на попадание.

Флаг делает две вещи: снимает запрет на `streaming: true` в `/open_session` и, если выбранный prefix cache сам не умеет сессии, оборачивает его в `StreamingSession`.

Это функциональность нативного API. Ни `/v1/chat/completions`, ни `/v1/completions`, ни `/v1/responses` streaming-сессий не открывают.

## Оригинальная справка

```text
Enable streaming session mode and StreamingSession wrapper.
```

## Паспорт аргумента

- Флаги: `--enable-streaming-session`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет
- Где объявлен: `ServerArgs.enable_streaming_session`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация prefix cache в планировщике (обертка) → проверка в `TokenizerManager.open_session` на каждом вызове → удержание KV между ходами сессии

## Что меняет в движке

### Обертка кеша

`sglang/python/sglang/srt/mem_cache/registry.py`, после выбора реализации дерева префиксов:

```python
if ctx.server_args.enable_streaming_session and not cache.supports_streaming_session():
    from sglang.srt.session.streaming_session import StreamingSession
    cache = StreamingSession(cache)
    streaming_wrapped = True
```

`UnifiedRadixCache` уже содержит `StreamingSession` внутри (`supports_streaming_session()` возвращает `True`), поэтому его не оборачивают; обычный `RadixCache` — оборачивают. Итог виден в логе:

```text
Tree cache initialized: source=… impl=… hybrid_swa=… hybrid_ssm=… hierarchical=… streaming_wrapped=…
```

### Гейт на открытие сессии

`TokenizerManager.open_session` (`sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`):

```python
if obj.streaming:
    if not self.server_args.enable_streaming_session:
        raise ValueError(
            "Streaming sessions are disabled. "
            "Please relaunch with --enable-streaming-session."
        )
```

Обычные (не streaming) сессии этим флагом не блокируются.

### Что происходит с KV

`StreamingSession` держит на сессию объект `SessionSlot` (`sglang/python/sglang/srt/session/streaming_session.py`), в который при завершении хода перекладываются `req_pool_idx`, `kv`, `kv_committed_len`, а для гибридных моделей — состояния Mamba. Ссылки в самом `Req` при этом обнуляются: владение переходит слоту, чтобы никакой поздний путь освобождения не тронул чужие тензоры. Следующий ход сессии восстанавливает состояние обратно в новый `Req` через `restore_to_req`.

Практический эффект: `cached_tokens` следующего хода равен `prompt + completion` предыдущего — ровно это и проверяет апстрим-тест `test_kv_cache_inheritance` (`sglang/python/sglang/test/kits/streaming_session_kit.py`). В отличие от обычного попадания в radix cache, здесь совпадение не «вероятное», а гарантированное: KV никуда не уходил и не мог быть вытеснен.

### Метрики

При `--enable-metrics` вместе с флагом появляются два гейджа: `sglang:num_streaming_sessions` и `sglang:streaming_session_held_tokens` (`sglang/python/sglang/srt/observability/metrics_collector.py`). Второй — прямой измеритель того, сколько KV сессии сейчас заняли.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — `/open_session` с `"streaming": true` отвечает ошибкой, обычные сессии продолжают работать.
- Само включение флага сессий не создает: сессию открывает клиент, `POST /open_session` с телом `{"capacity_of_str_len": N, "streaming": true}`, и закрывает `POST /close_session` с `{"session_id": ...}`.
- Запрос привязывается к сессии полем `session_params: {"id": <session_id>, "rid": <предыдущий rid>}` в теле `/generate`.

## Когда использовать

- Многоходовой диалог или пошаговый агент через нативный `/generate`, где обязателен нулевой перерасчет префикса между ходами, а не «как повезет с кешем».
- Длинный общий контекст, который дороже пересчитать, чем удержать в VRAM.
- **Не включайте**, если весь трафик идет через OpenAI-эндпоинты: они не открывают сессий, и флаг даст только лишнюю обертку кеша.
- **Не включайте** на инстансе с дефицитом KV-пула: удержанные слоты не участвуют в вытеснении, пока сессия не закрыта, — это прямой вычет из бюджета конкурентности.

## Влияние на производительность и память

- **VRAM/KV-пул**: главный эффект. Каждая живая сессия держит свои страницы KV до `/close_session`. Пул от этого не растет — сокращается доступная его часть. Забытая клиентом сессия — это утечка ёмкости до перезапуска сервера.
- **Prefill**: следующий ход сессии не считает префикс заново — экономия пропорциональна длине диалога.
- **CPU/RAM**: обертка добавляет один уровень делегирования на каждый вызов prefix cache; на фоне forward это шум.
- **Конкурентность**: чем больше открытых сессий, тем меньше свободных токенов у планировщика, тем раньше начинаются retraction'ы.

## Взаимодействие с другими аргументами

- `--enable-session-radix-cache`: соседний, но другой механизм — он добавляет пер-сессионные ссылки на записи `UnifiedRadixCache`, чтобы вытеснение сначала съедало неотреференсенные. Требует именно `UnifiedRadixCache` и падает с явной ошибкой на другой реализации. Streaming-сессии удерживают KV напрямую, а не через ссылки дерева.
- `--disable-radix-cache`: обертка ставится поверх выбранной реализации кеша; с отключенным деревом префиксов смысл сессий сводится только к удержанию слотов.
- `--enable-hierarchical-cache`: удержанные сессией слоты живут в device-пуле и в host-уровень не спускаются.
- `--max-running-requests` и `--mem-fraction-static`: определяют бюджет, из которого сессии откусывают. Планируйте ёмкость с учетом ожидаемого числа одновременно открытых сессий.
- `--enable-metrics`: без него двух гейджей по сессиям не будет.

## Типовые проблемы и диагностика

- `ValueError: Streaming sessions are disabled. Please relaunch with --enable-streaming-session.` — клиент открывает streaming-сессию на сервере без флага.
- **KV-пул «тает» без нагрузки** — открытые и не закрытые сессии. Смотрите `sglang:streaming_session_held_tokens` при `--enable-metrics`; лечится вызовом `/close_session` (или перезапуском).
- **`cached_tokens` следующего хода не равен сумме предыдущего** — сессия не передана в `session_params` либо `rid` предыдущего хода не указан.
- **Хотели ускорить многоходовой чат через OpenAI API** — не тот инструмент: там работает обычный radix cache, ему помогают `--schedule-policy lpm` и стабильный префикс запросов.
- Подтверждение обертки — строка `Tree cache initialized: … streaming_wrapped=True` при старте; принятое значение флага — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-streaming-session --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-streaming-session --enable-metrics --mem-fraction-static 0.85 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/session/streaming_session.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/test/kits/streaming_session_kit.py`
