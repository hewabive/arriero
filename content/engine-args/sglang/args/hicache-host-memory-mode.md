---
schema: 1
engine: sglang
primaryName: "--hicache-host-memory-mode"
title: "--hicache-host-memory-mode"
summary: "Выбирает постоянный host-кеш или временный буфер между GPU и storage. Buffer-only требует L3 и не поддерживается на decode-инстансе."
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-storage-backend
  - --hicache-write-policy
  - --hicache-ratio
  - --hicache-size
---

# --hicache-host-memory-mode

## Кратко

Выбирает постоянный host-кеш или временный буфер между GPU и storage. Buffer-only требует L3 и не поддерживается на decode-инстансе.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Whether host memory is a persistent HiCache tier (cache) or a transient staging buffer between GPU and the storage backend (buffer_only). buffer_only requires --hicache-storage-backend.
```

## Паспорт аргумента

- Флаг: `--hicache-host-memory-mode`
- Группа: `memory`
- Тип: `str`
- Декларативный default: `"cache"`
- Объявление: `ServerArgs.hicache_host_memory_mode` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

`cache` удерживает L2-префиксы в host memory. В `buffer_only` host pool обслуживает передачу и временно удерживает prefetch/backup; постоянные данные живут в storage. Валидация требует storage backend, запрещает `write_back` и disaggregation decode; обычный scheduler и prefill-инстансы поддерживаются.

## Значения и формат

`cache` по умолчанию, `buffer_only` для staging. При незаданном ratio вне decode выбирается соответственно `2.0` или `1.2`. Положительный `--hicache-size` имеет приоритет в обоих режимах.

## Когда использовать

Когда постоянный кеш должен находиться в L3, а RAM нужна только для передач и ожидающих prefetch. Для независимого L2 оставляйте `cache`.

## Влияние на производительность и память

Buffer-only не означает нулевой расход RAM: pinned host pool по-прежнему выделяется. Его ёмкость должна покрывать backlog записи и ожидающие чтения; маленький буфер усиливает зависимость от скорости storage.

## Взаимодействие с другими аргументами

Требует `--hicache-storage-backend` и поддерживает `write_through` либо `write_through_selective`. `--hicache-ratio` и `--hicache-size` задают ёмкость, а не режим удержания.

## Типовые проблемы и диагностика

Ошибки `requires a storage backend`, `does not support ... write_back` и `not supported on decode instances` означают несовместимую комбинацию. Смотрите фактически выделенную host memory и очередь storage.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-hierarchical-cache --hicache-storage-backend file --hicache-host-memory-mode buffer_only --hicache-write-policy write_through --hicache-ratio 1.2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
- `sglang/python/sglang/srt/mem_cache/hiradix_cache.py`
