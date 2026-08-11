---
schema: 1
engine: sglang
primaryName: "--enable-session-radix-cache"
title: "--enable-session-radix-cache"
summary: Привязывает узлы дерева префиксов к `session_id` запроса и вытесняет сначала неотмеченные узлы. Работает только на `UnifiedRadixCache`, то есть требует `SGLANG_ENABLE_UNIFIED_RADIX_TREE=1` или гибридной модели.
group: memory
related:
  - --enable-streaming-session
  - --radix-eviction-policy
  - --radix-cache-backend
  - --disable-radix-cache
---

# --enable-session-radix-cache

## Кратко

`--enable-session-radix-cache` дает многотуровым диалогам мягкую защиту от вытеснения: KV, оставшийся после запроса с `session_id`, помечается ссылкой сессии, и при нехватке слотов движок сначала выселяет все неотмеченное. Это именно приоритет, а не закрепление — при достаточном давлении отмеченный KV тоже уйдет. Главная эксплуатационная деталь: фича реализована **только** в `UnifiedRadixCache`, поэтому на обычной модели без `SGLANG_ENABLE_UNIFIED_RADIX_TREE=1` сервер откажется стартовать с явной ошибкой.

## Оригинальная справка

```text
Track per-session references on UnifiedRadixCache KV: eviction consumes unreferenced entries before referenced ones, and closing a session only dereferences its KV.
```

## Паспорт аргумента

- Флаги: `--enable-session-radix-cache`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; несовместимость проявляется как ошибка при построении дерева кеша, а не как автосброс
- Где объявлен: `ServerArgs.enable_session_radix_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение дерева кеша (`create_tree_cache`) → обработка каждого запроса с `session_id` и вызовов `/open_session` / `/close_session`

## Что меняет в движке

Значение уходит в `CacheInitParams.enable_session_radix_cache` (`mem_cache/kv_cache_builder.py`) и подхватывается ядром `UnifiedRadixCache` (`mem_cache/unified_cache/unified_tree_core.py`, `session_ref_tracker.py`). Сразу после создания кеша `create_tree_cache` проверяет:

```python
if ctx.server_args.enable_session_radix_cache and not getattr(cache, "enable_session_radix_cache", False):
    raise ValueError("--enable-session-radix-cache requires UnifiedRadixCache, but tree_cache is <Class>. Set SGLANG_ENABLE_UNIFIED_RADIX_TREE=1 (or remove --enable-session-radix-cache).")
```

`UnifiedRadixCache` строится, когда выполнено хотя бы одно: включен `SGLANG_ENABLE_UNIFIED_RADIX_TREE=1`, используется MLX-бэкенд, модель hybrid-SWA (кроме случая `full_tokens_per_layer == 0`), модель hybrid-SSM, либо HiCache поднят на hybrid/DSA-модели.

В работе:

- запрос с полем `session_id` считается «radix-native session» в `scheduler.py` — он идет обычным путем, а не через `session_controller`, и по завершении его переиспользуемые листья регистрируются под этим `session_id`;
- `/open_session` дополнительно вызывает `tree_cache.open_radix_session(...)`, `/close_session` — `release_radix_session(...)`; закрытие снимает ссылки, но KV не освобождает — он просто возвращается в обычный порядок вытеснения;
- вытеснение идет в два прохода: сначала узлы без ссылок, затем — при необходимости — узлы с наименьшим числом ссылок сессий, и уже внутри групп применяется выбранная `--radix-eviction-policy`. Компоненты (full-attention, SWA, Mamba) отслеживают ссылки независимо, но правила каскада `UnifiedRadixCache` сохраняются.

## Значения и формат

- Флаг без аргумента.
- Никаких лимитов на число сессий, TTL или квоту на сессию аргумент не задает.
- Приложение обязано присылать один и тот же **верхнеуровневый** `session_id` в каждом запросе диалога. Идентификатор только помечает ссылки на кеш: он не дописывает и не восстанавливает контекст, поэтому полный промпт по-прежнему передается в каждом запросе.
- Закрывать сессию (`POST /close_session`) нужно и на путях ошибок и отмен, иначе ссылки останутся висеть и будут искажать порядок вытеснения.

## Когда использовать

- Долгоживущие многотуровые диалоги и агентные сессии под конкурентной нагрузкой, когда чужие одноразовые запросы вымывают контекст активных сессий.
- Есть возможность гарантированно закрывать сессии — иначе преимущество вырождается: помеченным окажется почти все дерево.
- Не включайте, если модель обычная (не hybrid) и вы не готовы ставить `SGLANG_ENABLE_UNIFIED_RADIX_TREE=1`: старт упадет.
- Не рассматривайте как способ «закрепить» память за клиентом: защита мягкая, и гарантий сохранности KV она не дает.

## Влияние на производительность и память

- Дополнительной памяти под KV не требует: хранится только учет ссылок на узлы.
- На VRAM/RAM влияет опосредованно — меняется распределение уже имеющейся емкости в пользу активных сессий.
- Hit rate активных сессий растет, hit rate «фоновых» запросов падает: емкость перераспределяется, а не увеличивается.
- Небольшой CPU-оверхед на регистрацию ссылок при завершении запроса и на двухпроходное вытеснение.
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--radix-cache-backend`: сторонний backend должен сам поддерживать сессии, иначе сработает та же проверка в `create_tree_cache`.
- `--radix-eviction-policy`: применяется **внутри** групп «без ссылок» / «со ссылками», то есть не заменяется, а дополняется.
- `--enable-streaming-session`: другой механизм — обертка `StreamingSession` над кешем, не поддерживающим стриминг; включается независимо и в `create_tree_cache` проверяется отдельно.
- `--disable-radix-cache`: дерева нет, флаг теряет смысл (и при активном chunked prefill будет создан `ChunkCache`, который проверку не пройдет).
- `--enable-hierarchical-cache` на hybrid/DSA-моделях: ветка `UnifiedRadixCache` включается автоматически, и требование по env-переменной снимается.

## Типовые проблемы и диагностика

- `ValueError: --enable-session-radix-cache requires UnifiedRadixCache, but tree_cache is RadixCache. Set SGLANG_ENABLE_UNIFIED_RADIX_TREE=1 (or remove --enable-session-radix-cache).` — самая частая ошибка; либо задайте переменную окружения, либо снимите флаг.
- Эффекта нет, кеш ведет себя как раньше — проверьте, что клиент действительно передает `session_id` на каждом запросе, а не только на первом.
- Со временем защита перестает работать — вероятно, сессии не закрываются; вызывайте `POST /close_session` на всех путях завершения диалога.
- Тип созданного дерева подтверждает строка «Tree cache initialized: source=… impl=UnifiedRadixCache …».
- `session_id` — идентификатор, по которому группируется кеш: на инстансе, доступном не только с localhost, совпадение идентификаторов между клиентами означает общий приоритет вытеснения; выдавайте неугадываемые значения.

## Примеры

```bash
SGLANG_ENABLE_UNIFIED_RADIX_TREE=1 python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-session-radix-cache
```

```bash
SGLANG_ENABLE_UNIFIED_RADIX_TREE=1 python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-session-radix-cache --radix-eviction-policy lru --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/unified_tree_core.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/session_ref_tracker.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/session_radix_cache.mdx`
