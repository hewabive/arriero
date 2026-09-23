---
schema: 1
engine: vllm
primaryName: "--enable-mamba-fine-grained-prefix-cache"
title: "--enable-mamba-fine-grained-prefix-cache"
summary: Добавляет Mamba checkpoint в точке общего префикса для возобновления EAGLE/MTP.
group: CacheConfig
related: 
  - --mamba-cache-mode
  - --enable-prefix-caching
---

# --enable-mamba-fine-grained-prefix-cache

## Кратко

Добавляет Mamba checkpoint в точке общего префикса для возобновления EAGLE/MTP.

## Оригинальная справка

```text
Also register a Mamba "align" checkpoint at the shared-prefix junction --
where an EAGLE/MTP sibling was observed to resume -- instead of only at the
prompt tail. Off by default; only takes effect with `mamba_cache_mode`
"align", EAGLE on the Mamba group, and a prefix match unit smaller than the
Mamba block size.
```

## Паспорт аргумента

- Флаги: `--enable-mamba-fine-grained-prefix-cache`, `--no-enable-mamba-fine-grained-prefix-cache`
- Группа argparse: `CacheConfig`
- Тип значения: `bool`
- Значение по умолчанию в декларации: `False`
- Где объявлен: `vllm/config/cache.py:CacheConfig.enable_mamba_fine_grained_prefix_cache`

## Что меняет в движке

Помимо checkpoint в хвосте prompt сохраняется align checkpoint на границе shared prefix.

## Значения и формат

Парная форма `--no-enable-mamba-fine-grained-prefix-cache` выключает значение; отсутствие флага оставляет значение по умолчанию.

## Когда использовать

Имеет смысл только при mamba_cache_mode=align, EAGLE на Mamba-группе и единице prefix match меньше Mamba-блока.

## Влияние на производительность и память

Дополнительный checkpoint потребляет память cache, но может избежать повторной обработки общего префикса.

## Взаимодействие с другими аргументами

Связанные флаги: `--mamba-cache-mode`, `--enable-prefix-caching`.

## Типовые проблемы и диагностика

При отсутствии эффекта проверьте все три условия в конфигурации cache и speculative decoding.

## Примеры

```bash
vllm serve /models/model --enable-mamba-fine-grained-prefix-cache
```

## Источники

- `vllm/vllm/config/cache.py`
