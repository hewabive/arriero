---
schema: 1
engine: vllm
primaryName: "--prefix-cache-retention-interval"
title: "--prefix-cache-retention-interval"
summary: Задаёт частоту сохраняемых checkpoints prefix cache для sliding-window и Mamba групп.
group: CacheConfig
related: 
  - --enable-prefix-caching
  - --block-size
---

# --prefix-cache-retention-interval

## Кратко

Задаёт частоту сохраняемых checkpoints prefix cache для sliding-window и Mamba групп.

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
- Тип значения: `int`
- Значение по умолчанию в декларации: `Field(default=0, ge=0)`
- Где объявлен: `vllm/config/cache.py:CacheConfig.prefix_cache_retention_interval`

## Что меняет в движке

0 сохраняет только смысловые границы; положительное число добавляет периодические checkpoints и должно делиться на scheduler block size.

## Значения и формат

Допустимые значения и ограничения проверяются при разборе CLI и построении конфига.

## Когда использовать

Увеличивайте плотность checkpoint, если повторное воспроизведение после prefix hit дорого; None хранит checkpoints плотно.

## Влияние на производительность и память

Больше checkpoints тратит память cache, но уменьшает объём повторных вычислений.

## Взаимодействие с другими аргументами

Связанные флаги: `--enable-prefix-caching`, `--block-size`.

## Типовые проблемы и диагностика

При ошибке конфигурации проверьте кратность block size.

## Примеры

```bash
vllm serve /models/model --prefix-cache-retention-interval 0
```

## Источники

- `vllm/vllm/config/cache.py`
