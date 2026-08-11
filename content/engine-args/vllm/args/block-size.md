---
schema: 1
engine: vllm
primaryName: "--block-size"
title: "--block-size"
summary: Размер страницы KV-cache в токенах. Задавать вручную почти никогда не нужно: значение выбирает attention-backend, а гибридные и skip-quant конфигурации поднимают его принудительно.
group: CacheConfig
related:
  - --attention-backend
  - --mamba-block-size
  - --prefix-match-unit
  - --decode-context-parallel-size
  - --kv-cache-dtype-skip-layers
  - --gpu-memory-utilization
---

# --block-size

## Кратко

`--block-size` задает `CacheConfig.block_size` — сколько токенов помещается в один блок (страницу) KV-cache. Это единица выделения памяти в block pool, единица гранулярности prefix caching и единица, по которой планировщик округляет `num_computed_tokens`.

Значение почти всегда определяется не человеком, а attention-backend'ом и требованиями модели. Явный `--block-size` имеет смысл только когда вы точно знаете ограничение конкретного kernel'а: неудачное значение молча уводит движок на backend с меньшим приоритетом.

## Оригинальная справка

```text
Size of a contiguous cache block in number of tokens.
Accepts None (meaning "use default"). After construction, always int.
```

## Паспорт аргумента

- Флаги: `--block-size`
- Группа argparse: `CacheConfig`
- Тип значения: int (целое число токенов)
- Допустимые значения: не ограничены на уровне парсера; ограничение `gt=0` проверяет pydantic, реальные ограничения приходят от attention-backend
- Значение по умолчанию: `Field(default=None, gt=0)` — то есть `None` («взять дефолт») при валидации «строго больше нуля»
- Эффективное значение: `None` превращается в `CacheConfig.DEFAULT_BLOCK_SIZE = 16` в валидаторе `_apply_block_size_default`; далее `Platform.update_block_size_for_backend()` заменяет его на `backend.get_preferred_block_size(...)`, если пользователь не задал флаг явно; для гибридных mamba-моделей и для конфигураций со `--kv-cache-dtype-skip-layers` значение может быть поднято **даже если задано вручную**; после сборки KV-cache `EngineCore._initialize_kv_caches` перезаписывает поле минимальным block size среди KV-cache групп
- Где объявлен: `vllm/config/cache.py:CacheConfig.block_size`
- Этап применения: разбор CLI → сборка `VllmConfig` → выбор attention-backend → профилирование и выделение KV-cache → планировщик

## Что меняет в движке

Значение проходит через четыре стадии, и на каждой оно может измениться.

1. **Валидация конфига.** `_apply_block_size_default` подставляет 16, если флаг не задан, и одновременно выставляет служебный флаг `user_specified_block_size = True`, если задан. Дальше весь код различает «пользователь выбрал» и «выбрал движок» именно по нему.
2. **Выбор backend'а.** `update_block_size_for_backend` (`vllm/platforms/interface.py`) спрашивает у выбранного не-SSM backend'а `get_preferred_block_size(16)`. Backend отвечает исходя из `get_supported_kernel_block_sizes()`: FlashAttention и Triton — `MultipleOf(16)`, FlashMLA — фиксированные `64`, CutlassMLA — `128`. Эта фаза пропускается, если флаг задан вручную.
3. **Выравнивание под гибридные и разнотипные страницы.** Для `model_config.is_hybrid` вызывается `_align_hybrid_block_size`: attention-страница обязана быть не меньше mamba-страницы, поэтому `block_size` поднимается до `attn_block_size`, а mamba-страница добивается паддингом. Для непустого `kv_cache_dtype_skip_layers` вызывается `_align_heterogeneous_kv_block_size`: квантованная «основная» страница поднимается так, чтобы покрыть страницу неквантованных skip-слоев. Обе фазы перекрывают пользовательское значение и пишут в лог `Setting attention block size to %d tokens ...`.
4. **После выделения KV-cache.** `EngineCore._initialize_kv_caches` ставит `cache_config.block_size = min(g.kv_cache_spec.block_size for g in kv_cache_groups)`, после чего `VllmConfig.validate_block_size()` проверяет совместимость с decode-context-parallel и с `mamba_cache_mode == "align"`.

Дальше значение читают: `get_num_blocks` (сколько блоков влезло в профилированную память), block pool и KV-cache manager (единица аллокации), `resolve_kv_cache_block_sizes` (scheduler block size = `block_size * decode_context_parallel_size`, hash block size для prefix caching).

## Значения и формат

- Целое число токенов, строго больше нуля. Практически осмысленны только значения, кратные требованию kernel'а: для FlashAttention/Triton — кратные 16, для FlashMLA — кратные 64, для CutlassMLA — кратные 128.
- `supports_block_size` считает значение допустимым, если оно **делится** на поддерживаемый размер, а не строго равно ему. Для backend'а, объявившего `[64]`, значение `128` допустимо, а `32` — нет.
- Специальных значений (`0`, `-1`, `auto`) нет; `0` и отрицательные отвергаются валидацией pydantic.
- На CPU-платформе действуют отдельные правила (`vllm/platforms/cpu.py`): без явного флага берется 128, для CPU MLA принудительно 16 (с предупреждением, если пользователь задал другое), и выводится предупреждение, если значение не кратно 32.

## Когда использовать

- Когда вы намеренно фиксируете backend и знаете его требование к странице — например, воспроизводите чужой бенчмарк, где `--block-size` зафиксирован.
- Когда нужно управлять гранулярностью prefix caching в конфигурации с одной KV-cache группой: там hash block size равен block size, то есть попадание в кэш возможно только на границах блока. Более тонкую границу дает `--prefix-match-unit`, а не уменьшение `--block-size`.
- **Не трогайте** его «для экономии памяти»: суммарный объем KV-cache задается профилированием и не зависит от размера блока напрямую. Меняется только внутренняя фрагментация (недозаполненный последний блок каждой последовательности) и накладные расходы на block table.
- Не трогайте его на гибридных mamba/attention-моделях: `_align_hybrid_block_size` все равно поднимет значение до требуемого, и ваш выбор будет лишь нижней границей.

## Влияние на производительность и память

- **VRAM.** Общий размер KV-cache определяется доступной после профилирования памятью, а не блоком; блок задает, сколько байт занимает одна страница (`page_size_bytes = block_size × байты_на_токен_на_слой`). Крупный блок увеличивает потери на хвосте каждой последовательности (в среднем полблока на запрос) и уменьшает достижимую concurrency; мелкий блок увеличивает длину block table и число индексных операций.
- **Prefix caching.** Кэш-хит возможен только на границе хэш-блока. При одной группе это ровно `block_size`: с `--block-size 128` общий префикс в 120 токенов не даст ни одного попадания.
- **Выбор backend'а.** Явный `--block-size`, несовместимый с более приоритетным backend'ом, приводит к его отбраковке. В логе появится предупреждение вида `--block-size %d precluded higher-priority backend(s) %s. Using %s instead, which may result in reduced performance.`
- **Время старта.** Само значение на компиляцию и прогрев не влияет, но смена backend'а из-за него — влияет.

## Взаимодействие с другими аргументами

- `--attention-backend`: реальный источник ограничений на размер блока. Если backend выбран явно и не поддерживает ваш `--block-size`, старт падает с `Selected backend ... is not valid for this configuration. Reason: ['block_size not supported']`.
- `--mamba-block-size`: для гибридных моделей оба размера выравниваются друг относительно друга; в режиме `--mamba-cache-mode align` mamba-блок принудительно приравнивается к `block_size`.
- `--prefix-match-unit`: позволяет хэшировать префикс мельче физического блока (каждый групповой `block_size` должен делиться на него нацело).
- `--decode-context-parallel-size`: scheduler block size равен `block_size × dcp`; дополнительно `validate_block_size()` требует, чтобы `cp_kv_cache_interleave_size` не превышал `block_size` и делил его нацело.
- `--kv-cache-dtype-skip-layers` и `--kv-cache-dtype`: разные dtype в одном пуле заставляют поднять `block_size`, чтобы страницы совпали по размеру.
- `--gpu-memory-utilization` и `--kv-cache-memory-bytes`: задают, сколько памяти делится на страницы; `--block-size` задает, какого размера эти страницы.

## Типовые проблемы и диагностика

- **Симптом:** в логе `Setting kv cache block size to 64 for FLASHMLA backend.`, хотя вы ничего не задавали. **Причина:** штатная работа фазы 2 — backend сам выбрал размер. Подтверждение: строка `Using ... attention backend out of potential backends: ...` рядом.
- **Симптом:** `Selected backend ... is not valid for this configuration. Reason: ['block_size not supported']`. **Причина:** несовместимость явного `--block-size` с явным `--attention-backend`. **Лечение:** убрать `--block-size` или привести его к кратному требованию kernel'а.
- **Симптом:** предупреждение `--block-size N precluded higher-priority backend(s) ...` и просевший throughput. **Причина:** ваш размер блока исключил быстрый backend. **Лечение:** убрать `--block-size`.
- **Симптом:** на гибридной модели значение выросло до сотен или тысяч токенов, prefix cache почти не дает попаданий. **Причина:** `Setting attention block size to %d tokens to ensure that attention page size is >= mamba page size.` — mamba-страница крупная, attention-страница подтягивается к ней. **Лечение:** не `--block-size`, а `--prefix-match-unit` для более тонкой границы совпадения.
- **Проверка итогового значения:** строка `GPU KV cache size: N tokens, Maximum concurrency for M tokens per request: X.XXx` показывает результат уже после всех выравниваний; на своей сборке список принимаемых значений подтверждается `vllm serve --help`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --block-size 32 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --attention-backend FLASH_ATTN --block-size 16 --max-model-len 8192
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/vllm/platforms/cpu.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/v1/attention/backend.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/config/vllm.py`
