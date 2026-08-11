---
schema: 1
engine: sglang
primaryName: "--hicache-io-backend"
title: "--hicache-io-backend"
summary: Выбирает механизм копирования KV между хостом и GPU в HiCache: GPU-ассистированные ядра (`kernel`) или обычные асинхронные копии (`direct`). Жестко связан с `--hicache-mem-layout` — несовместимая пара молча переписывается на старте.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-mem-layout
  - --hicache-storage-backend
  - --disaggregation-decode-enable-offload-kvcache
---

# --hicache-io-backend

## Кратко

`--hicache-io-backend` — это выбор транспорта для уровня L2↔L1: `kernel` использует специализированные GPU-ядра переноса KV, `direct` — обычные асинхронные копии памяти. Значение имеет смысл только вместе с `--hicache-mem-layout`: допустимы не все четыре комбинации, и `__post_init__` приводит их к валидной паре сам, печатая предупреждение. Третье значение `kernel_ascend` — не альтернатива для NVIDIA/AMD, а внутренний путь Ascend NPU, который платформа выставляет себе сама.

## Оригинальная справка

```text
The IO backend for KV cache transfer between CPU and GPU
```

## Паспорт аргумента

- Флаги: `--hicache-io-backend`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `direct`, `kernel`, `kernel_ascend`
- Значение по умолчанию: `kernel`
- Эффективное значение: `_resolve_layout_io_compatibility` в `__post_init__` меняет `kernel` на `direct`, если задан layout `page_first_direct`; на Ascend NPU `hardware_backend/npu/utils.py` принудительно выставляет `kernel_ascend` вместе с соответствующим layout
- Где объявлен: `ServerArgs.hicache_io_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; значение `kernel_ascend` — платформенное, для CUDA/ROCm непригодно
- Этап применения: `__post_init__` (`_handle_hicache`) → создание `HiCacheController` → каждая операция загрузки/выгрузки KV

## Что меняет в движке

Значение передается в `HiCacheController(io_backend=…)` и читается в двух местах:

- `HiCacheController.move_indices` (`sglang/python/sglang/srt/managers/cache_controller.py`) — где именно должны лежать индексные тензоры. Для `kernel` индексы уходят на GPU, для `direct` они остаются на CPU (и при `layer_first` дополнительно сортируются), для `kernel_ascend` — device-индексы переводятся на CPU;
- пулы хоста (`mem_cache/pool_host/mha.py`, `mla.py`, `memory_pool_host.py`) — какой примитив переноса вызвать: `transfer_kv_*` (GPU-ядра) для `kernel`, `transfer_kv_*_direct` для `direct`, `transfer_kv_dim_exchange` и родственные для `kernel_ascend`.

Нормализация пары layout/IO происходит до этого, в `_handle_hicache`:

- `page_first_direct` + `kernel` → IO переключается на `direct` («Kernel io backend does not support page first direct layout, switching to direct io backend»);
- `page_first` + `direct` → меняется **layout**, а не IO: он становится `page_first_direct` («Page first layout is not supported with direct IO backend, switching to page first direct layout»).

Комбинации, не покрытые кодом переноса, приводят к `ValueError` уже в рантайме: `Unsupported io_backend: …` из пула или `Unsupported layout … for io backend 'direct'` из контроллера. Практически это означает, что `kernel_ascend` вне NPU-пулов не работает.

## Значения и формат

- `kernel` (по умолчанию) — GPU-ассистированные ядра переноса. Апстрим-документация рекомендует их как более быстрый вариант; совместимы с layout `layer_first` и `page_first`.
- `direct` — стандартные асинхронные копии. Совместимы с `layer_first` и `page_first_direct`; при `page_first` layout будет автоматически заменен на `page_first_direct`.
- `kernel_ascend` — путь Ascend NPU. Задавать вручную на CUDA/ROCm бессмысленно: соответствующие ветки есть только в NPU-пулах, а платформа и так выставляет это значение сама при `--enable-hierarchical-cache`.
- Значение вне списка отвергает argparse.

## Когда использовать

- Оставляйте `kernel`, если не выбираете layout сознательно: это дефолт и рекомендованный апстримом путь.
- Берите `direct`, когда нужен layout `page_first_direct` — например, в конфигурациях с L3 (`hf3fs`, `mooncake`) из апстрим-руководства, где `--hicache-mem-layout page_first_direct --hicache-io-backend direct` идут парой и дают zero-copy при агрегации на уровне «страница-слой».
- Не задавайте `kernel_ascend` руками: на NPU он выставляется автоматически, на других платформах он приведет к ошибке переноса, а не к отказу на старте.

## Влияние на производительность и память

- На объем памяти не влияет: и L1, и L2 уже выделены к моменту первого переноса.
- Влияет на пропускную способность канала хост↔GPU: по данным апстрим-документации GPU-ассистированные ядра дают до трехкратного выигрыша против базового `cudaMemcpyAsync`.
- Влияет на распределение работы: при `kernel` часть переноса выполняет GPU (занимает SM'ы), при `direct` — копировальные движки. На загруженной карте это может менять картину не в пользу `kernel`.
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--enable-hierarchical-cache`: без него (и без `--disaggregation-decode-enable-offload-kvcache`) нормализация `_handle_hicache` не выполняется и значение не читается.
- `--hicache-mem-layout`: связаны жестко, см. правила нормализации выше. Изменение одного часто меняет второе.
- `--hicache-storage-backend mooncake`: при `layer_first` layout переписывается на `page_first` для `kernel` и на `page_first_direct` для `direct` (`_resolve_storage_layout_compatibility`); при `kernel_ascend` layout остается как есть.
- `--disaggregation-decode-enable-offload-kvcache`: активирует ту же нормализацию, даже если сам HiCache не включен.

## Типовые проблемы и диагностика

- В логе «Kernel io backend does not support page first direct layout, switching to direct io backend» — ваш `kernel` заменен на `direct`. Это не ошибка, но если вы рассчитывали на GPU-ядра, поменяйте layout.
- В логе «Page first layout is not supported with direct IO backend, switching to page first direct layout» — заменен layout, IO остался вашим.
- `ValueError: Unsupported io_backend: kernel_ascend` или `Unsupported layout … for io backend 'direct'` в рантайме при первой передаче — выбрана комбинация, для которой нет пути переноса.
- Итоговую пару layout/IO показывает дамп `server_args=` при старте: он печатается уже после `__post_init__`, то есть с учетом всех автозамен.
- Пропускную способность L2↔L1 удобно сравнивать по TTFT на запросах, целиком попадающих в L2, при `--enable-cache-report`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 3 --hicache-io-backend kernel --hicache-mem-layout page_first
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --page-size 64 --enable-hierarchical-cache --hicache-ratio 2 --hicache-io-backend direct --hicache-mem-layout page_first_direct --hicache-storage-backend hf3fs
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/mha.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/mla.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool_host.py`
- `sglang/python/sglang/srt/hardware_backend/npu/utils.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
