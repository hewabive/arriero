---
schema: 1
engine: sglang
primaryName: "--page-size"
title: "--page-size"
summary: Гранула выделения KV-кеша в токенах и одновременно шаг совпадения префикса в radix cache. Объявленный default `null` почти всегда переписывается движком под выбранный attention backend и архитектуру модели.
group: schedule
related:
  - --chunked-prefill-size
  - --attention-backend
  - --decode-attention-backend
  - --prefill-attention-backend
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --hicache-ratio
  - --swa-full-tokens-ratio
  - --kv-events-config
---

# --page-size

## Кратко

`--page-size` задает, сколько токенов лежит в одной странице KV-пула. Это одновременно единица выделения памяти (аллокатор раздает страницы, а не токены), единица округления при поиске префикса в radix cache и единица хеширования для HiCache и внешних роутеров. Трогают его обычно не ради «настройки», а потому что выбранный attention backend принимает только конкретные значения — и тогда важно знать, что движок все равно поправит значение сам и напишет об этом в лог.

## Оригинальная справка

```text
The number of tokens in a page.
```

## Паспорт аргумента

- Флаги: `--page-size`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: `choices` нет; практически принимаются значения, которые переживут проверки backend'а и пула. Реально используемый набор — `1`, `16`, `32`, `64`, `128`, `256`
- Значение по умолчанию: `null` — значит «подберет движок»
- Эффективное значение: подбирается в несколько шагов и почти всегда отличается от `null`. Финальную подстановку делает `_handle_page_size` → `_page_size_default` (`sglang/python/sglang/srt/arg_groups/overrides.py`): `1` на обычных платформах, `64` на MUSA, `64` на ROCm при `SGLANG_AITER_KV_CACHE_LAYOUT=vectorized_5d`. Но до нее уже отработали привязки к backend'у и к архитектуре модели (см. ниже) — они пишут значение и в том случае, когда оно задано вручную
- Где объявлен: `ServerArgs.page_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`, то есть проходит через пайплайн деклараций `arg_groups/overrides.py`
- Этап применения: `__post_init__` (подбор значения) → выделение KV-пула и создание аллокатора → построение radix cache → инициализация attention backend → каждая итерация планировщика

## Что меняет в движке

Значение доходит до трех независимых потребителей.

**Аллокатор KV.** `BaseTokenToKVPoolAllocator` (`sglang/python/sglang/srt/mem_cache/allocator/base.py`) при `page_size > 1` держит список свободных страниц: `num_pages = max_total_num_tokens // page_size`, а `available_size()` возвращает число свободных и освобождаемых страниц, умноженное на `page_size`. Любое выделение округляется вверх до страницы.

**Планировщик.** `PrefillAdder` (`sglang/python/sglang/srt/managers/schedule_policy.py`) считает бюджет в токенах, но округляет длину каждого запроса вверх до страницы (`ceil_paged_tokens`) и дополнительно резервирует ровно одну `page_size` на запрос как «page_overhead» в `_update_prefill_budget`. То есть при `--page-size 128` каждый принятый в prefill запрос списывает с бюджета минимум 128 лишних токенов сверх своей длины.

**Radix cache.** `RadixKey.match(...)` (`sglang/python/sglang/srt/mem_cache/radix_cache.py`) округляет длину совпавшего префикса **вниз** до кратной `page_size`, а ключи узлов дерева строятся по `child_key(page_size)`. Следствие: с `--page-size 64` общий префикс в 100 токенов дает переиспользование только 64 токенов, остальные 36 будут пересчитаны.

Дополнительно значение публикуется наружу как `block_size` в дескрипторе `--kv-events-config` (`ServerArgs` в `sglang/python/sglang/srt/server_args.py`): внешний роутер обязан хешировать промпты именно этим шагом, иначе он будет промахиваться мимо кеша.

Подбор значения, если оно не задано, идет в таком порядке внутри `__post_init__`:

1. `_handle_model_specific_adjustments` — переопределения по архитектуре: DeepSeek V4 → `256` (`128` на NPU), sm100 с дефолтным `trtllm_mha` → `64` (иначе `1`), Qwen3-VL на ROCm с `SGLANG_USE_AITER_UNIFIED_ATTN` → `16`, diffusion-LLM → `dllm_block_size`.
2. `_handle_attention_backend_compatibility` — привязки к backend'у (`_mla_backend_page_constraints`, `_fa4_page_constraint`, `_intel_xpu_page_constraint`).
3. `_handle_page_size` — подстановка платформенного дефолта, только если после шагов 1-2 значение все еще `null`.

## Значения и формат

- Целое число токенов. Значение `1` — «постраничности нет», аллокатор работает по одному токену; это базовый режим на CUDA.
- Привязки к attention backend (каждая печатает `logger.warning` и **перетирает** заданное вручную значение):
  - `flashmla` → всегда `64`;
  - `cutlass_mla` → всегда `128`;
  - `trtllm_mla`, `tokenspeed_mla`, `cutedsl_mla` → допускаются `32` и `64`, иначе `64`;
  - `trtllm_mha` → допускаются `16`, `32`, `64`, `128`, иначе `64`;
  - `hpc_ops` → всегда `64`;
  - `fa4` на non-MLA модели, sm100, при `speculative_eagle_topk <= 1` → `128`;
  - `intel_xpu` на decode → `{16,32,64,128}` для MLA и `{64,128}` иначе, иначе `128`.
- Жесткие проверки, которые роняют старт:
  - `chunked_prefill_size % page_size == 0` — при включенном chunked prefill и режиме, отличном от `--disaggregation-mode decode`;
  - для SSM/Mamba-моделей `max(chunk_size, page_size) % min(chunk_size, page_size) == 0`;
  - `mamba_track_interval % page_size == 0`;
  - `MambaRadixCache` v1 требует `page_size == 1`, `PureSWATokenToKVPoolAllocator` — тоже;
  - режим `no_buffer` допускает только `page_size=1`;
  - сжатое внимание DSV4 требует кратности 128.
- Степень двойки формально не проверяется, но все поддерживаемые значения — степени двойки; нестандартное значение молча пройдет argparse и упрется в assert в пуле или в kernel.

## Когда использовать

- Задавайте явно, когда включены HiCache/L3-хранилище: страница — единица хеширования и передачи между уровнями, и на `--page-size 1` слой L2/L3 деградирует до пооперационного трафика. Практический ориентир апстрима в примерах HiCache — `--page-size 64`.
- Задавайте явно, если внешний роутер потребляет `--kv-events-config`: его `block_size` обязан совпадать.
- Не подбирайте значение «под backend» вручную: движок сам приведет его к допустимому и напишет warning. Ручной подбор нужен только там, где допустимых значений несколько (`trtllm_mla`: 32 против 64; `trtllm_mha`: 16/32/64/128).
- Не увеличивайте page-size ради экономии — на префиксном кеше он работает против вас: чем крупнее страница, тем короче засчитанный общий префикс.

## Влияние на производительность и память

- VRAM: сам по себе размер пула не меняет (пул считается в токенах и выравнивается вниз по странице), но растет внутренняя фрагментация: до `page_size - 1` неиспользованных токенов на запрос плюс одна страница резерва на запрос в бюджете допуска. При `--page-size 256` и сотне одновременных запросов это десятки тысяч токенов пула.
- Throughput: крупные страницы удешевляют работу с таблицами страниц и включают paged-kernel'ы MLA-backend'ов — на DeepSeek-подобных моделях это основной источник выигрыша.
- Prefix cache hit rate: падает с ростом страницы, потому что совпадение округляется вниз. На нагрузке с длинными общими системными промптами эффект малозаметен, на коротких разнородных запросах — заметен сразу.
- Время старта: не меняется.
- RAM хоста: влияет только через HiCache — host-пул адресуется теми же страницами.

## Взаимодействие с другими аргументами

- `--chunked-prefill-size`: обязана делиться на `page_size` нацело, иначе старт падает с `chunked_prefill_size must be divisible by page_size`. Это самая частая причина отказа при ручном page-size.
- `--attention-backend` / `--decode-attention-backend` / `--prefill-attention-backend`: главный источник переопределения значения.
- `--disable-radix-cache`: снимает вопрос гранулярности совпадения префикса, оставляя только гранулярность выделения.
- `--enable-hierarchical-cache`, `--hicache-ratio`: HiCache адресует host-пул страницами; page-size задает размер блока переноса.
- `--swa-full-tokens-ratio`: размеры full- и SWA-пулов выравниваются вниз по `page_size` (`align_page_size` в `sglang/python/sglang/srt/model_executor/pool_configurator.py`).
- `--kv-events-config`: публикует `page_size` как `block_size` наружу.

## Типовые проблемы и диагностика

- Старт падает с `AssertionError: chunked_prefill_size must be divisible by page_size` — приведите `--chunked-prefill-size` к кратному значению (например, `8192` при `--page-size 64`).
- В логе `FlashMLA only supports a page_size of 64, change page_size to 64.` или `TensorRT-LLM MLA only supports page_size of 32 or 64, changing page_size from … to 64.` — ваше значение проигнорировано backend'ом; это не ошибка, но дальнейшие расчеты (в том числе делимость chunked prefill) уже идут по новому значению.
- Внезапно низкий `#cached-token` в строке `Prefill batch, #new-seq: …, #new-token: …, #cached-token: …` при неизменной нагрузке — типичный признак того, что page-size вырос (сам или через backend) и префиксы стали засчитываться грубее.
- Фактическое принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) и в строке `max_total_num_tokens=…, chunked_prefill_size=…`.
- Assert вида `Page size must be 1 for MambaRadixCache v1, got 64` — модель с Mamba-слоями не поддерживает постраничность; уберите `--page-size`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --chunked-prefill-size 8192 --enable-hierarchical-cache --hicache-ratio 3
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --attention-backend trtllm_mla --page-size 32 --chunked-prefill-size 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/mem_cache/allocator/base.py`
- `sglang/python/sglang/srt/mem_cache/radix_cache.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
