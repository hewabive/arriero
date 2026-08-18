---
schema: 1
engine: vllm
primaryName: "--prefix-cache-retention-interval"
title: "--prefix-cache-retention-interval"
summary: Задает, с каким шагом (в токенах) удерживать checkpoint-блоки prefix cache для sliding-window и Mamba групп. Дефолт `0` хранит только семантические checkpoint'ы; `None` возвращает старое плотное удержание, положительное значение добавляет периодические checkpoint'ы.
group: CacheConfig
related:
  - --enable-prefix-caching
  - --block-size
  - --mamba-block-size
  - --mamba-cache-mode
  - --prefix-match-unit
  - --disable-sliding-window
---

# --prefix-cache-retention-interval

## Кратко

Sliding-window и Mamba слои не могут переиспользовать произвольный префикс: попадание в prefix cache для них возможно только на «checkpoint'ах» — позициях, где сохранено локальное состояние (последнее окно / mamba-state). `--prefix-cache-retention-interval` управляет тем, сколько таких checkpoint'ов удерживается в пуле блоков: плотно (каждый), только семантические (границы, о которые реально бьются повторные запросы) или семантические плюс периодическая сетка с заданным шагом в токенах.

Аргумент появился в PR #52216 как промоушен переменной окружения `VLLM_PREFIX_CACHE_RETENTION_INTERVAL` в полноценный CLI-флаг; тем же PR **дефолт изменен с плотного удержания на `0`**. Старая переменная окружения объявлена deprecated (удаление в v0.29) и пока читается как фолбэк с предупреждением в логе.

## Оригинальная справка

```text
Token interval between retained sliding-window and Mamba prefix-cache
checkpoints. ``0`` retains only semantic checkpoints, including the latest
replay boundary and shared-prefix junctions. Positive values additionally
retain periodic checkpoints at the specified interval, which must be a
multiple of the scheduler block size. ``None`` retains checkpoints densely.
Applies only to sliding-window and Mamba cache groups.
```

## Паспорт аргумента

- Флаги: `--prefix-cache-retention-interval`
- Группа argparse: `CacheConfig`
- Тип значения: int, допускается `None` (`optional: true`)
- Значение по умолчанию: `Field(default_factory=_get_prefix_cache_retention_interval, ge=0)` — фабрика возвращает `0`, если deprecated-переменная `VLLM_PREFIX_CACHE_RETENTION_INTERVAL` не задана, иначе её значение
- Валидация: `ge=0` на уровне pydantic; при старте `_validate_prefix_cache_retention_interval` дополнительно требует кратности `scheduler_block_size` и наличия sliding-window/Mamba группы (см. «Типовые проблемы»)
- Где объявлен: `vllm/config/cache.py:CacheConfig.prefix_cache_retention_interval`
- Этап применения: `create_engine_config` → `KVCacheConfig.prefix_cache_retention_interval` (`get_kv_cache_config_from_groups`) → `KVCacheCoordinator.retention_interval` → `find_longest_cache_hit` менеджеров групп

## Что меняет в движке

Значение прокидывается из `CacheConfig` в `KVCacheConfig` и читается координатором KV-cache (`vllm/v1/core/kv_cache_coordinator.py`). Для full-attention групп оно инертно — там любой полный блок и так является точкой попадания. Для sliding-window и Mamba групп оно определяет, какие checkpoint-блоки остаются удерживаемыми в пуле для будущих попаданий:

- `None` — плотное удержание: сохраняется каждый checkpoint (поведение vLLM до PR #52216);
- `0` — только семантические checkpoint'ы: последняя replay-граница (конец промпта на момент допуска) и точки ветвления общих префиксов (shared-prefix junctions);
- положительное `N` — семантические плюс периодические checkpoint'ы каждые `N` токенов; `N` обязан быть кратен `scheduler_block_size`, чтобы попадать на реальные границы cache-hit.

## Значения и формат

- `0` (дефолт): минимальное удержание, покрывающее типовые сценарии повторного использования (перезапрос того же диалога, общий системный промпт).
- Кратное `scheduler_block_size` положительное число, например `--prefix-cache-retention-interval 2048`: попадания возможны и в «середину» длинного префикса с точностью до 2048 токенов.
- `None`: плотное удержание, прежнее поведение. Поле `optional`, поэтому CLI принимает литерал `None`: `--prefix-cache-retention-interval None`.

## Когда использовать

Трогать стоит только на гибридных моделях (sliding-window или Mamba слои) с включенным prefix caching и рабочей нагрузкой, где повторные запросы продолжают префикс не с сохраненных семантических границ — например, отрезание хвоста контекста на стороне клиента или ветвящиеся агентные запросы с разной длиной общего префикса. Тогда периодическая сетка (`N` в несколько тысяч токенов) возвращает часть попаданий ценой удержания большего числа блоков. На чисто full-attention моделях аргумент бесполезен: оставляйте `0`.

## Влияние на производительность и память

Прямо на VRAM-аллокацию не влияет — пул блоков фиксирован после профилирования. Влияет на то, какая доля пула занята удерживаемыми checkpoint-блоками sliding-window/Mamba групп: плотное удержание (`None`) и мелкая сетка держат больше блоков, вытесняя обычный переиспользуемый кэш и снижая эффективную ёмкость prefix cache; `0` освобождает промежуточные checkpoint'ы сразу. Скорость влияет через hit rate: чем реже checkpoint'ы, тем чаще повторный запрос с «нестандартной» границей пойдет в полный prefill гибридных групп.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: без prefix caching удержание checkpoint'ов не имеет смысла — аргумент инертен.
- `--block-size` / `--mamba-block-size`: положительное значение обязано быть кратно `scheduler_block_size`; при гибридной модели итоговый размер блока может быть доопределен движком, и кратность проверяется уже против него.
- `--mamba-cache-mode`: checkpoint'ы Mamba-группы существуют в режимах `all`/`align`; в `none` кэшировать нечего.
- `--prefix-match-unit`: гранулярность сопоставления префикса — соседняя ручка того же механизма попаданий.
- `--disable-sliding-window`: превращает sliding-window слои в полные — sliding-window группа исчезает, аргумент остается осмысленным только для Mamba.

## Типовые проблемы и диагностика

- **`prefix_cache_retention_interval is set but this model has no sliding-window or Mamba KV cache group...`** при старте: значение больше `0` задано для модели без гибридных групп. Уберите флаг или верните `0` (с `0` проверка проходит на любой модели).
- **`prefix_cache_retention_interval (N) must be non-negative and a multiple of scheduler_block_size (M).`**: подберите `N` кратным фактическому размеру блока планировщика — он виден в логе старта и может отличаться от заданного `--block-size` на гибридных моделях.
- **Предупреждение о deprecated `VLLM_PREFIX_CACHE_RETENTION_INTERVAL`** в логе: значение пришло из старой переменной окружения; перенесите его в CLI-флаг до v0.29.
- **После обновления vLLM упал hit rate prefix cache на гибридной модели**: это смена дефолта с плотного удержания на `0` в PR #52216, а не регрессия вашей конфигурации; верните плотность периодической сеткой.

## Примеры

```bash
vllm serve /models/gpt-oss-120b --enable-prefix-caching --prefix-cache-retention-interval 0
```

```bash
vllm serve /models/Nemotron-H-8B --enable-prefix-caching --mamba-cache-mode align --prefix-cache-retention-interval 2048
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/kv_cache_coordinator.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/kv_cache_interface.py`
- https://github.com/vllm-project/vllm/pull/52216
