---
schema: 1
engine: vllm
primaryName: "--prefix-match-unit"
title: "--prefix-match-unit"
summary: Гранулярность ключей prefix-cache в токенах для моделей с несколькими группами KV-cache. Позволяет ловить попадания на границах внутри крупного физического блока; на модели с одной группой не действует вовсе.
group: CacheConfig
related:
  - --enable-prefix-caching
  - --block-size
  - --mamba-block-size
  - --mamba-cache-mode
  - --disable-hybrid-kv-cache-manager
  - --prefix-caching-hash-algo
  - --kv-transfer-config
  - --decode-context-parallel-size
---

# --prefix-match-unit

## Кратко

Prefix caching ищет совпадение префикса по цепочке хешей, вычисляемых через фиксированное число токенов. У гибридной модели (например перемежающиеся full-attention и mamba-слои) группы KV-cache имеют разные размеры блока, и по умолчанию шаг хеширования равен их НОД. `--prefix-match-unit` задаёт этот шаг вручную и позволяет сделать его мельче — вплоть до попаданий внутрь крупного физического блока.

Ограничение жёсткое: каждая группа обязана иметь `block_size`, кратный этому значению. И ещё жёстче: **на модели с одной группой KV-cache аргумент игнорируется полностью** — там шаг хеширования всегда равен размеру блока планировщика.

## Оригинальная справка

```text
The finest token boundary (in tokens) a prefix-cache hit can land on.

Prefix-cache keys are computed every `prefix_match_unit` tokens. It can
be set finer than the physical KV cache block sizes (e.g. 32 vs a
1024-token hybrid-model block) as long as every KV cache group's
`block_size` is divisible by it, enabling cache hits at boundaries
inside a physical block. It controls matching granularity only, not how
often states are stored.

This equals to the `hash_block_size` used throughout the KV cache code.
```

## Паспорт аргумента

- Флаги: `--prefix-match-unit`
- Группа argparse: `CacheConfig`
- Тип значения: int (токены); принимает `None` и пустую строку как «не задано»
- Допустимые значения: `Field(default=None, gt=0)` — строго положительное целое, ноль и отрицательные отвергает pydantic
- Значение по умолчанию: `None` — шаг выбирает движок
- Эффективное значение: определяется в `resolve_kv_cache_block_sizes()`. Одна группа KV-cache ⇒ значение **не читается вовсе**, шаг равен `block_size × decode_context_parallel_size`. Prefix caching выключен и KV-connector'а нет ⇒ шаг равен блоку планировщика. Есть mamba-группа с `mamba_cache_mode != "align"` ⇒ шаг тоже откатывается к блоку планировщика. Только в оставшемся случае берётся заданное значение, а при его отсутствии — НОД размеров блоков всех групп
- Где объявлен: `vllm/config/cache.py:CacheConfig.prefix_match_unit`
- Этап применения: инициализация engine core после построения `KVCacheConfig` — значение уходит в `Scheduler`/`BlockPool` как `hash_block_size`

## Что меняет в движке

`EngineCore.__init__` вызывает `resolve_kv_cache_block_sizes(kv_cache_config, vllm_config)` и получает пару `(scheduler_block_size, hash_block_size)`. Первое — инвариант выравнивания для планировщика (НОК эффективных размеров блока по группам), второе — шаг, с которым `get_request_block_hasher()` считает `Request.block_hashes`: по одному цепочечному хешу на каждые `hash_block_size` токенов префикса.

Дальше `hash_block_size` живёт в `BlockPool` и читается менеджерами отдельных типов кэша. Менеджеры, у которых `supports_fine_grained_hash_lookup = True` (`FullAttentionManager` и его наследники `RSWAManager`/`SinkFullAttentionManager`, а также `MambaManager`), при `hash_block_size < block_size` умеют пробовать границы внутри физического блока через `BlockHashListWithBlockSize`; остальные (`SlidingWindowManager`, `ChunkedLocalAttentionManager`, `CrossAttentionManager`) переиспользуют те же хеши, но сопоставляют их только на границах своих блоков.

Планировщик учитывает мелкий шаг отдельно: при `hash_block_size < block_size` и mamba-группе в режиме `align` он выставляет `mamba_partial_cache_hit` и добавляет точку остановки ровно на последней хеш-границе промпта, иначе частичное состояние mamba зарегистрировать нечем.

Ключевое в справке проговорено прямым текстом: аргумент управляет **гранулярностью сопоставления**, а не тем, как часто состояния сохраняются. Физические блоки остаются прежнего размера, и хранится по-прежнему блок целиком.

## Значения и формат

- Число токенов, обязательно делитель размера блока каждой группы. Нарушение — `ValueError: Invalid prefix_match_unit=N; all KV cache group block sizes must be divisible by prefix_match_unit. Got group block sizes=[...]`.
- Практичные значения — степени двойки: 16, 32, 64. Размеры блоков в vLLM кратны 16, а у гибридных моделей mamba-блок бывает на порядок крупнее.
- `None` (или строка `None`, или пустая строка) возвращает автоматический выбор — НОД размеров блоков.
- Значение больше размера какого-либо блока автоматически нарушает делимость и отвергается.
- В хеш конфигурации компиляции параметр не входит (`prefix_match_unit` перечислен в `ignored_factors` у `CacheConfig.compute_hash`) — менять его можно без инвалидации кеша компиляции.
- При `--decode-context-parallel-size > 1` размеры блоков attention-групп умножаются на DCP до проверки делимости; mamba-группы не масштабируются.

## Когда использовать

- **Гибридная модель с крупным mamba-блоком.** Классический случай из справки: mamba-блок 1024 токена рядом с attention-блоком 16. Без флага шаг равен НОД (16); флаг здесь скорее нужен, чтобы шаг **укрупнить** и сократить длину списка хешей, если промпты длинные, а попадания всё равно приходят на грубых границах.
- **Диалоговая нагрузка с почти совпадающими префиксами.** Мелкий шаг увеличивает шанс попасть в кеш, когда общий префикс не кратен крупному блоку.
- **KV-offloading и P/D-разнесение.** Шаг хеширования — это же гранулярность ключей у KV-connector'ов (mooncake, cpu-offload); он должен быть согласован между узлами, поэтому фиксировать его явно осмысленно.
- **Не трогайте на обычной трансформерной модели.** Там одна группа KV-cache и аргумент не читается — «оптимизация» будет чистой иллюзией.
- **Не гонитесь за минимальным значением.** Каждый шаг — это отдельный хеш на каждые N токенов промпта: на 128 K контекста шаг 16 даёт 8192 хешей на запрос против 512 при шаге 256.

## Влияние на производительность и память

- **VRAM.** Не влияет: размеры блоков и число блоков не меняются, память под KV-cache считается до этого.
- **RAM хоста и CPU планировщика.** Прямо пропорционально: число хешей на запрос равно `num_tokens / prefix_match_unit`. Уменьшение шага вдвое удваивает и объём списка `Request.block_hashes`, и стоимость хеширования (алгоритм задаётся `--prefix-caching-hash-algo`), и длину поиска самого длинного совпадения.
- **Время до первого токена.** Более удачное попадание в prefix cache — меньше пересчёта prefill; это и есть выигрыш. Он реален только если ваши префиксы действительно расходятся внутри блока.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: при выключенном prefix caching и без KV-connector'а значение игнорируется — `resolve_kv_cache_block_sizes` возвращает блок планировщика.
- `--block-size`: задаёт размер блока attention-групп, то есть верхнюю границу и условие делимости.
- `--mamba-block-size`: размер блока mamba-группы; чаще всего именно он делает НОД мелким или крупным.
- `--mamba-cache-mode`: значение отличное от `align` полностью отключает мелкий шаг (`resolve_kv_cache_block_sizes` откатывается к блоку планировщика).
- `--disable-hybrid-kv-cache-manager`: сводит модель к одной группе KV-cache, после чего аргумент перестаёт что-либо значить.
- `--prefix-caching-hash-algo`: определяет стоимость одного хеша; вместе с шагом даёт полную цену хеширования запроса.
- `--kv-transfer-config`: KV-connector — вторая причина, по которой хеши вообще считаются; часть коннекторов (mooncake) требует, чтобы `block_size` был кратен `hash_block_size`, и проверяет это своими ассертами.
- `--decode-context-parallel-size`: масштабирует размеры блоков attention-групп перед проверкой делимости.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Invalid prefix_match_unit=48; all KV cache group block sizes must be divisible by prefix_match_unit. Got group block sizes=[16, 1024].` **Причина:** значение не делит все размеры блоков. **Лечение:** взять делитель НОД перечисленных в сообщении размеров.
- **Симптом:** задали значение, попадания в prefix cache не изменились. **Причина:** самая частая — у модели одна группа KV-cache, и значение не читается; вторая — `--enable-prefix-caching` выключен; третья — `--mamba-cache-mode` не `align`. **Проверка:** `Got group block sizes=[...]` появляется только при нескольких группах; метрику попаданий смотреть в `/metrics` (`vllm:prefix_cache_hits_total` против `vllm:prefix_cache_queries_total`).
- **Симптом:** выросла загрузка CPU процесса engine core на длинных промптах. **Причина:** слишком мелкий шаг, хеширование каждого запроса подорожало. **Лечение:** укрупнить значение или вернуть автоматический выбор.
- **Симптом:** ассерт про делимость внутри KV-connector'а (`block_size must be divisible by hash_block_size`). **Причина:** коннектор настроен на свою гранулярность, не согласованную с этой. **Лечение:** привести значения в соответствие на всех узлах.
- **Подтверждение принятого значения:** отдельной строки в логе нет. Косвенно значение проявляется в поведении: при `hash_block_size < block_size` планировщик начинает резать шаги по хеш-границам промпта для mamba-групп.

## Примеры

```bash
vllm serve /models/hybrid-mamba-model --enable-prefix-caching --prefix-match-unit 64 --block-size 16
```

```bash
vllm serve /models/hybrid-mamba-model --enable-prefix-caching --prefix-match-unit 256 --mamba-cache-mode align --max-model-len 32768
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/core/single_type_kv_cache_manager.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/v1/mooncake/store/coordinator.py`
