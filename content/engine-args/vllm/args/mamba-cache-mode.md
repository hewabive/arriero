---
schema: 1
engine: vllm
primaryName: "--mamba-cache-mode"
title: "--mamba-cache-mode"
summary: Стратегия сохранения состояния mamba-слоев для prefix caching. Декларативный дефолт none почти всегда переопределяется движком: при включенном prefix caching режим становится all для поддерживающих моделей и align для остальных.
group: CacheConfig
related:
  - --enable-prefix-caching
  - --mamba-block-size
  - --block-size
  - --enable-chunked-prefill
  - --use-replayssm
  - --disable-chunked-mm-input
---

# --mamba-cache-mode

## Кратко

Prefix caching для attention-слоев тривиален: KV-блок либо посчитан, либо нет. Для mamba-слоев нужно решить, в каких точках последовательности сохранять рекуррентное состояние, чтобы с них можно было продолжить. `--mamba-cache-mode` выбирает эту политику.

Значение по умолчанию (`none`) вводит в заблуждение: реальный режим определяется тем, включен ли prefix caching, и поддерживает ли модель кэширование mamba-состояний.

## Оригинальная справка

```text
The cache strategy for Mamba layers:

- "none": set when prefix caching is disabled.
- "all": cache the mamba state of all tokens at position i * block_size. This is
  the default behavior (for models that support it) when prefix caching is enabled.
- "align": only cache the mamba state of the last token of each scheduler step and
  when the token is at position i * block_size.
```

## Паспорт аргумента

- Флаги: `--mamba-cache-mode`
- Группа argparse: `CacheConfig`
- Тип значения: enum (строка)
- Допустимые значения: `all`, `align`, `none` (тип `MambaCacheMode` в `vllm/config/cache.py`)
- Значение по умолчанию: `none`
- Эффективное значение: `MambaModelConfig.verify_and_update_config` меняет его почти всегда. При включенном prefix caching: `none` → `all` для модели с `supports_mamba_prefix_caching`, иначе `align`; явный `all` на модели без поддержки → `align` с предупреждением. При выключенном prefix caching любой режим принудительно становится `none`, тоже с предупреждением
- Где объявлен: `vllm/config/cache.py:CacheConfig.mamba_cache_mode`
- Этап применения: сборка `VllmConfig` (переопределение) → выравнивание блоков под backend → построение mamba KV-cache spec → планировщик и forward

## Что меняет в движке

**Переопределение.** `MambaModelConfig.verify_and_update_config` (вызывается из `try_verify_and_update_config` в `VllmConfig.__post_init__`) — единственное место, где режим меняется:

- prefix caching включен, режим `none` → `all` для модели с `supports_mamba_prefix_caching`, иначе `align`; warning-строка `Mamba cache mode is set to '<mode>' for <Architecture> by default when prefix caching is enabled`;
- prefix caching включен, режим `all`, но модель не объявляет `supports_mamba_prefix_caching` → `align`, предупреждение `Hybrid or mamba-based model detected without support for prefix caching with Mamba cache 'all' mode: falling back to 'align' mode.`;
- режим `align` требует chunked prefill: `assert vllm_config.scheduler_config.enable_chunked_prefill, "Chunked prefill is required for mamba cache mode 'align'."`;
- prefix caching выключен → `none`, предупреждение `Mamba cache mode is set to 'none' when prefix caching is disabled`.

**Размер блоков.** `_align_hybrid_block_size` ведет себя по-разному: в `all` mamba-блок вычисляется из chunk size модели (или из `--mamba-block-size`) и `attn_block_size` подтягивается к нему; в остальных режимах берется минимальный размер, удовлетворяющий выравниванию kernel'а и размеру mamba-страницы. После выравнивания в режиме `align` выполняется `mamba_block_size = block_size`.

**Планировщик.** При `align` планировщик взводит `need_mamba_block_aligned_split` и режет запросы по границам блоков; `validate_block_size()` дополнительно требует, чтобы chunked multimodal input не был отключен (`disable_chunked_mm_input`), иначе разбиение по границе блока невозможно.

**Хэширование префикса.** `resolve_kv_cache_block_sizes` отключает более тонкую границу совпадения (`hash_block_size`), если хотя бы одна mamba-группа не в режиме `align`. То есть `all` и `none` заставляют хэшировать по scheduler-блоку целиком.

**Metadata builder.** В режиме `all` mamba-backend аллоцирует таблицу состояний размером `cdiv(max_model_len, block_size) + num_speculative_blocks` на каждую строку CUDA-graph-батча; в остальных режимах — узкую таблицу `1 + num_spec_tokens`.

## Значения и формат

- `none` — состояния не кэшируются между запросами; блок совпадает со всей последовательностью (`mamba_block_size = max_model_len`). Единственный режим при выключенном prefix caching.
- `align` — состояние сохраняется только для последнего токена каждого шага планировщика и только когда он попал на границу блока. Дешево по памяти и по числу записей; дефолт при включенном prefix caching для моделей без `supports_mamba_prefix_caching`.
- `all` — состояние сохраняется на каждой границе `i × block_size`. Больше точек продолжения (лучше hit rate), дороже по памяти и по записям; требует, чтобы модель объявляла поддержку, и для таких моделей является дефолтом при включенном prefix caching.

## Когда использовать

- Оставляйте автоматический выбор. Он корректен для подавляющего большинства случаев: при prefix caching — `all` на поддерживающей модели и `align` на остальных, `none` без него.
- Явный `align` имеет смысл на модели с `supports_mamba_prefix_caching`, когда дефолтный `all` слишком дорог по памяти (широкие таблицы состояний, крупный блок) и вы готовы отдать часть hit rate.
- `none` при включенном prefix caching задавать бессмысленно: движок все равно поднимет режим до `all` или `align`.
- Не задавайте `all` вместе с `--use-replayssm` — это запрещенная комбинация (см. ниже).

## Влияние на производительность и память

- **VRAM.** `all` увеличивает число сохраняемых mamba-состояний и размер metadata-таблиц; `align` держит их минимальными; `none` не хранит ничего между запросами.
- **Hit rate.** `all` дает больше точек продолжения; `align` — только границы, попавшие на конец шага планировщика.
- **Гранулярность prefix caching в целом.** Только `align` разрешает более тонкий `hash_block_size` при нескольких KV-cache группах.
- **Планирование.** `align` заставляет резать запросы по границам блоков; это дополнительное ограничение на формирование батча.
- **Attention-блок.** В `all` mamba-блок вычисляется из chunk size и может заметно поднять `--block-size`.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: главный переключатель. Без него режим всегда `none`.
- `--enable-chunked-prefill`: обязателен для `align` — иначе ассерт на старте.
- `--mamba-block-size`: в `align` перезаписывается значением `--block-size`; в `all` служит базовым чанком.
- `--block-size`: в `all` подтягивается вверх под mamba-страницу.
- `--use-replayssm`: допускает только `none` и `align`; при `all` старт падает с `--use-replayssm supports prefix caching only in align mode; pass --mamba-cache-mode align`.
- `--disable-chunked-mm-input`: несовместим с `align` (ассерт в `validate_block_size()`).

## Типовые проблемы и диагностика

- **Симптом:** `Chunked prefill is required for mamba cache mode 'align'.` **Причина:** chunked prefill выключен, а режим разрешился в `align`. **Лечение:** включить chunked prefill либо выключить prefix caching.
- **Симптом:** задан `all`, в логе `falling back to 'align' mode`. **Причина:** модель не объявляет `supports_mamba_prefix_caching`. **Лечение:** ничего — это ограничение реализации модели.
- **Симптом:** задан `align`, но prefix caching выключен, и в логе `Mamba cache mode is set to 'none' when prefix caching is disabled`. **Причина:** штатное принудительное понижение. **Лечение:** добавить `--enable-prefix-caching`.
- **Симптом:** `Chunked MM input is required because we need the flexibility to schedule a multiple of block_size tokens even if they are in the middle of a mm input` на мультимодальной модели. **Причина:** `align` вместе с отключенным chunked MM input. **Лечение:** не отключать chunked MM input.
- **Проверка итогового режима:** warning-строка `Mamba cache mode is set to '<mode>' for <Architecture> by default when prefix caching is enabled` в логе старта; следом идет info-строка о том, что поддержка prefix caching для mamba-слоев экспериментальна.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --enable-prefix-caching --mamba-cache-mode align
```

```bash
vllm serve /models/Nemotron-H-8B --enable-prefix-caching --mamba-cache-mode all --mamba-block-size 256
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/attention/backends/mamba_attn.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
