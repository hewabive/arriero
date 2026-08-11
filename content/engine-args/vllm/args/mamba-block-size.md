---
schema: 1
engine: vllm
primaryName: "--mamba-block-size"
title: "--mamba-block-size"
summary: Гранулярность блока состояния mamba-слоев в токенах. Задается только вместе с prefix caching, кратен 8 из-за kernel'а causal_conv1d и в режиме align все равно приравнивается к --block-size.
group: CacheConfig
related:
  - --mamba-cache-mode
  - --enable-prefix-caching
  - --block-size
  - --max-model-len
  - --mamba-cache-dtype
  - --replayssm-buffer-len
---

# --mamba-block-size

## Кратко

У mamba-слоев нет KV-cache в привычном смысле: они хранят рекуррентное состояние (conv-state и ssm-state). Чтобы prefix caching работал и на них, состояние сохраняется на границах блоков — `--mamba-block-size` задает шаг этих границ в токенах.

Аргумент почти всегда лишний: значение выводится из `--block-size` и режима `--mamba-cache-mode`, а в режиме `align` принудительно приравнивается к `--block-size`. Задавать его руками имеет смысл только в режиме `all`, где оно служит базовым размером чанка.

## Оригинальная справка

```text
Size of a contiguous cache block in number of tokens for mamba cache.
Can be set only when prefix caching is enabled.
Value must be a multiple of 8 to align with causal_conv1d kernel.
```

## Паспорт аргумента

- Флаги: `--mamba-block-size`
- Группа argparse: `CacheConfig`
- Тип значения: int (токены)
- Допустимые значения: не ограничены списком; `gt=0` на уровне pydantic, кратность 8 проверяется уже в kernel'е `causal_conv1d` (`assert (block_size_to_align % BLOCK_M) == 0`, где `BLOCK_M = 8`). Дополнительно принимается литерал `None`
- Значение по умолчанию: `Field(default=None, gt=0)` — `None` при валидации «строго больше нуля»
- Эффективное значение: `MambaModelConfig.verify_and_update_config` подставляет `cache_config.block_size` при включенном prefix caching и `model_config.max_model_len` при выключенном; далее для гибридных моделей `_align_hybrid_block_size` в режиме `all` пересчитывает его из mamba-страницы и chunk size, а в режиме `align` жестко приравнивает к итоговому `cache_config.block_size`
- Где объявлен: `vllm/config/cache.py:CacheConfig.mamba_block_size`
- Этап применения: сборка `VllmConfig` (дефолт и запрет без prefix caching) → выравнивание под backend после построения слоев → построение mamba KV-cache spec → forward

## Что меняет в движке

Значение хранится вместе с флагом `user_specified_mamba_block_size`, который взводится в валидаторе `CacheConfig`, если аргумент задан явно. Дальше:

1. **Запрет.** Валидатор `VllmConfig.validate_mamba_block_size` падает с `--mamba-block-size can only be set with --enable-prefix-caching`, если значение задано (и не равно `max_model_len`) при выключенном prefix caching.
2. **Дефолт.** `MambaModelConfig.verify_and_update_config` при включенном prefix caching ставит `mamba_block_size = block_size`; при выключенном — `max_model_len`, то есть «одно состояние на всю последовательность, границ нет».
3. **Выравнивание.** Для гибридных attention/mamba-моделей `_align_hybrid_block_size` в режиме `mamba_cache_mode == "all"` берет пользовательское значение (или `model_config.get_mamba_chunk_size()`) как базовый чанк, вычисляет `chunk_size = lcm(base_chunk_size, kernel_block_alignment_size)` и получает `attn_block_size`, который становится и `mamba_block_size`, и нижней границей для `cache_config.block_size`. В режиме `align` после выравнивания выполняется `cache_config.mamba_block_size = cache_config.block_size` — пользовательское значение теряется.
4. **Использование.** `MambaSpec` строится с этим блоком; в forward mamba-миксеров он передается как `block_size_to_align` в `causal_conv1d` и как шаг chunk-раскладки в mamba2-kernel'ах.

## Значения и формат

- Целое число токенов, кратное 8. Некратное значение доходит до kernel'а и падает там на ассерте, а не отклоняется парсером.
- `None` или пустая строка — вернуть автоматический выбор.
- Значение, равное `max_model_len`, трактуется валидатором как «не задано»: `mamba_block_size_is_set` проверяет именно неравенство `max_model_len`. Такой аргумент не приведет к ошибке даже без prefix caching.
- Крупное значение означает редкие точки сохранения состояния (меньше памяти, грубее гранулярность prefix cache), мелкое — обратное.

## Когда использовать

- В режиме `--mamba-cache-mode all` — чтобы задать базовый размер чанка, если дефолтный chunk size модели дает неудобный `attn_block_size`.
- Когда включен `--use-replayssm`: справка ReplaySSM отмечает, что флаши эффективнее всего, когда `mamba_block_size` кратен `--replayssm-buffer-len` (это рекомендация, а не требование).
- **Не задавайте** в режиме `align` — значение будет перезаписано `--block-size`.
- Не задавайте при выключенном prefix caching — старт откажет.

## Влияние на производительность и память

- **VRAM.** Определяет, сколько копий состояния mamba хранится: страница mamba-состояния фиксированного размера умножается на число блоков. Мелкий блок означает больше сохраненных состояний и больший расход.
- **Prefix caching на mamba-слоях.** Попадание возможно только на границе блока; крупный блок делает кэш почти бесполезным на коротких общих префиксах.
- **Attention-страница.** Через `_align_hybrid_block_size` крупный mamba-блок тянет вверх `--block-size`, а с ним — гранулярность всего prefix caching.
- **Kernel.** Значение задает раскладку чанков в mamba2-kernel'ах; несогласованное с chunk size модели значение приводит к дополнительным чанкам на блок.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: жесткая предпосылка; без него аргумент запрещен, а дефолт становится `max_model_len`.
- `--mamba-cache-mode`: в `align` значение принудительно равно `--block-size`; в `all` оно служит базовым чанком; в `none` границ нет.
- `--block-size`: в гибридных моделях два размера выравниваются друг под друга, причем attention-страница обязана быть не меньше mamba-страницы.
- `--max-model-len`: дефолт при выключенном prefix caching и «нейтральное» значение для валидатора.
- `--replayssm-buffer-len` и `--use-replayssm`: кратность буфера дает более эффективные флаши.
- `--mamba-cache-dtype`, `--mamba-ssm-cache-dtype`: задают размер одного состояния, а этот аргумент — их количество.

## Типовые проблемы и диагностика

- **Симптом:** `--mamba-block-size can only be set with --enable-prefix-caching`. **Причина:** значение задано без prefix caching. **Лечение:** добавить `--enable-prefix-caching` либо убрать аргумент.
- **Симптом:** `The mamba block size needs to be divisible by the BLOCK_M` на первом же forward. **Причина:** значение не кратно 8. **Лечение:** округлить до кратного 8.
- **Симптом:** значение задано, но в конфиге оказалось другое. **Причина:** режим `align` перезаписывает его значением `--block-size`, а режим `all` — вычисленным `attn_block_size`. **Проверка:** строка `Setting attention block size to %d tokens to ensure that attention page size is >= mamba page size.` в логе старта.
- **Симптом:** `Padding mamba page size by X% to ensure that mamba page size and attention page size are exactly equal.` **Причина:** штатное добивание mamba-страницы до attention-страницы; большой процент означает, что память тратится на паддинг. **Лечение:** подобрать `--block-size`/`--mamba-block-size` так, чтобы страницы были ближе.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --enable-prefix-caching --mamba-cache-mode all --mamba-block-size 256
```

```bash
vllm serve /models/Nemotron-H-8B --enable-prefix-caching --mamba-cache-mode align --block-size 128
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/model_executor/layers/mamba/ops/causal_conv1d.py`
- `vllm/vllm/model_executor/layers/mamba/abstract.py`
