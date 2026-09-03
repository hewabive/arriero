---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-retraction-backup"
title: "--disaggregation-decode-retraction-backup"
summary: Выбирает, куда decode-узел PD сохраняет KV вытесненного запроса: в отдельные CPU-тензоры или в заранее выделенный host-пул HiCache. Если значение не задано, backend выбирается после построения device KV-пула.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-decode-enable-radix-cache
  - --disaggregation-decode-enable-offload-kvcache
  - --hicache-ratio
  - --hicache-size
  - --dcp-size
  - --enable-priority-scheduling
  - --disable-priority-preemption
---

# --disaggregation-decode-retraction-backup

## Кратко

При retraction decode-узел освобождает VRAM запроса, но позже должен продолжить генерацию без повторного prefill. Аргумент выбирает хостовое хранилище этого KV: отдельные тензоры на каждый запрос (`cpu_tensor`) либо общий заранее зарезервированный HiCache L2-пул (`host_pool`).

## Оригинальная справка

```text
Storage backend for KV preserved across PD decode retraction. 'cpu_tensor' uses per-request CPU tensors. 'host_pool' uses a reserved HiCache pool and does not fall back on exhaustion. If omitted, the backend is inferred from the decode KV pool.
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-retraction-backup`
- Группа: `disagg`
- Тип значения: optional string
- Допустимые значения: `cpu_tensor`, `host_pool`
- Декларативное значение по умолчанию: `null`
- Где объявлен: `ServerArgs.disaggregation_decode_retraction_backup`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: после построения device KV-пула (`resolve_decode_retraction_backup`) → retraction/restore каждого запроса

## Что меняет в движке

При `null` SGLang выбирает `host_pool`, только если это PD decode, DCP выключен, decode radix cache и отдельный decode-offload выключены, priority preemption не активен, а построенный KV-пул — MHA либо hybrid-SWA с full-слоями. Во всех остальных случаях выбирается `cpu_tensor`.

`cpu_tensor` вызывает `Req.offload_kv_cache`/`load_kv_cache` и держит backup в объекте запроса. `host_pool` строит `UnifiedRadixCache` с L2-пулом, выделяет host slots атомарно и синхронно завершает device→host копирование перед освобождением VRAM. Если после reclaim места нет, сервер получает `RuntimeError`; fallback на `cpu_tensor` нет.

## Значения и формат

- `cpu_tensor` — совместимый путь с динамическими per-request allocations.
- `host_pool` — фиксированный pool с предсказуемым RAM-бюджетом и повторным использованием slots.
- Не задан — поздний выбор по фактически построенному KV-пулу; итог может отличаться от `null` в раннем дампе аргументов.

## Когда использовать

Явно задавайте backend для воспроизводимой эксплуатации PD decode. `host_pool` полезен при частых retraction и заранее выделенном запасе RAM; `cpu_tensor` выбирайте при DCP, priority preemption, decode radix cache, pure-SWA/Mamba или когда отдельный HiCache pool нежелателен.

## Влияние на производительность и память

Оба режима копируют KV между GPU и host и увеличивают latency retraction/resume. `host_pool` заранее резервирует pinned RAM: при незаданном `--hicache-ratio` его размер равен device pool (`1.0`). `cpu_tensor` расходует RAM по мере числа и длины вытесненных запросов и сильнее зависит от поведения allocator'а.

## Взаимодействие с другими аргументами

- `--disaggregation-mode decode` обязателен для явного `host_pool`.
- `--hicache-ratio` / `--hicache-size` задают емкость host pool; исчерпание не переключает backend.
- `--dcp-size > 1` с `host_pool` запрещен.
- `--disaggregation-decode-enable-offload-kvcache` и `host_pool` взаимно исключены: оба строят decode host pool.
- При `--enable-priority-scheduling` нужен `--disable-priority-preemption`.

## Типовые проблемы и диагностика

- `...host_pool is only supported on a PD decode server` — выбран не decode-узел.
- `...host_pool does not support --dcp-size > 1` — используйте `cpu_tensor`.
- `Retraction host KV pool exhausted after reclaim` — увеличьте host pool или снизьте конкурентность; автоматического fallback нет.
- Итоговый backend публикуется в runtime config bags и используется в `retraction_backup`/`retraction_restore`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-retraction-backup host_pool --hicache-ratio 1
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-retraction-backup cpu_tensor
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/common.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`

