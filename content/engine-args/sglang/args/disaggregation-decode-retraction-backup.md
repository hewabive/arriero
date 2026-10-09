---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-retraction-backup"
title: "--disaggregation-decode-retraction-backup"
summary: Выбирает, куда decode-узел PD сохраняет KV вытесненного запроса — в отдельные CPU-тензоры или в заранее выделенный host-пул HiCache, — либо (`none`) не сохраняет вовсе и обрывает такой запрос с 503. Если значение не задано, backend выбирается после построения device KV-пула.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-decode-enable-radix-cache
  - --disaggregation-decode-enable-offload-kvcache
  - --disaggregation-decode-host-receive-threshold
  - --hicache-ratio
  - --hicache-size
  - --dcp-size
  - --enable-priority-scheduling
  - --disable-priority-preemption
---

# --disaggregation-decode-retraction-backup

## Кратко

При retraction decode-узел освобождает VRAM запроса, но позже должен продолжить генерацию без повторного prefill. Аргумент выбирает хостовое хранилище этого KV: отдельные тензоры на каждый запрос (`cpu_tensor`) либо общий заранее зарезервированный HiCache L2-пул (`host_pool`). Третье значение, `none`, отказывается от backup'а целиком: вытесненный запрос не возобновляется, а завершается с HTTP 503, и повтор ложится на клиента.

## Оригинальная справка

```text
Storage backend for KV preserved across PD decode retraction. 'cpu_tensor' uses per-request CPU tensors. 'host_pool' uses a reserved HiCache pool and does not fall back on exhaustion. 'none' keeps no backup: a retracted request is aborted with 503 for the client to retry. If omitted, the backend is inferred from the decode KV pool.
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-retraction-backup`
- Группа: `disagg`
- Тип значения: optional string
- Допустимые значения: `cpu_tensor`, `host_pool`, `none`
- Декларативное значение по умолчанию: `null`
- Эффективное значение: `null` разрешается в `cpu_tensor` или `host_pool` (но никогда в `none`) функцией `resolve_decode_retraction_backup` после построения KV-пула; при `--disaggregation-decode-host-receive-threshold > 0` обработчик `handle_pd_disaggregation` еще в пайплайне `__post_init__` переписывает значение в `host_pool`
- Где объявлен: `python/sglang/srt/arg_groups/fields/disagg.py:Disagg.disaggregation_decode_retraction_backup`
- Статус: обычный
- Этап применения: `__post_init__` (проверки `handle_cache_compatibility`, `handle_pd_disaggregation`) → после построения device KV-пула (`resolve_decode_retraction_backup`) → retraction/restore каждого запроса

## Что меняет в движке

При `null` SGLang выбирает `host_pool`, только если это PD decode не на ROCm/HIP, DCP выключен, decode radix cache и отдельный decode-offload выключены, priority preemption не активен, у модели нет рекуррентного состояния (SSM/Mamba), а построенный KV-пул — MHA либо hybrid-SWA с full-слоями; под `--enable-unified-memory` добавляются ограничения на hybrid-SWA и draft-пулы спекуляции. Во всех остальных случаях выбирается `cpu_tensor`. Итог публикуется в config bags через `override`, поэтому ранний дамп `server_args=` показывает `null`.

Retraction идет в `ScheduleBatch.retract_decode`: запросы снимаются с конца отсортированного списка, пока не хватит памяти на decode-шаг, и последний запрос батча никогда не снимается. Для каждого снятого запроса `release_req` вызывает `backup_kv_cache` и только потом освобождает device KV:

- `cpu_tensor` вызывает `Req.offload_kv_cache`/`load_kv_cache` и держит backup в объекте запроса.
- `host_pool` строит `UnifiedRadixCache` с L2-пулом, выделяет host slots атомарно (с попыткой освободить место вытеснением host-узлов) и синхронно завершает device→host копирование перед освобождением VRAM. Если места нет и после reclaim, fallback на `cpu_tensor` нет: запрос завершается `FINISH_ABORT` с HTTP 500.
- `none` сразу возвращает «backup не сделан». Запрос завершается `FINISH_ABORT` с HTTP 503 и текстом «Retracted under decode memory pressure without a KV backup. Retry later.». Host-пул для retraction при этом не строится, и `handle_hicache` не нормализует HiCache-параметры, если сам HiCache не включен.

Исключение для всех трех значений: DeepSeek-V4.1 со спекуляцией DSPARK (`dsv41_dspark_needs_rebootstrap`) backup не делает вовсе — запрос переподнимается с пересчетом KV.

## Значения и формат

- `cpu_tensor` — совместимый путь с динамическими per-request allocations.
- `host_pool` — фиксированный pool с предсказуемым RAM-бюджетом и повторным использованием slots.
- `none` — ни RAM, ни копирования; каждое retraction превращается в отказ с 503. Автоматически не выбирается никогда, только явно.
- Не задан — поздний выбор по фактически построенному KV-пулу; итог может отличаться от `null` в раннем дампе аргументов.

## Когда использовать

- Явно задавайте backend для воспроизводимой эксплуатации PD decode. `host_pool` полезен при частых retraction и заранее выделенном запасе RAM; `cpu_tensor` выбирайте при DCP, priority preemption, decode radix cache, pure-SWA/Mamba или когда отдельный HiCache pool нежелателен.
- `none` — когда перед decode-узлами стоит роутер или клиент, который умеет повторять запрос на 503 (например, отправить его на другой decode-инстанс), а RAM под backup держать не хочется. Без такого повтора `none` превращает давление на KV-пул в видимые клиенту ошибки.

## Влияние на производительность и память

`cpu_tensor` и `host_pool` копируют KV между GPU и host и увеличивают latency retraction/resume. `host_pool` заранее резервирует pinned RAM: при незаданном `--hicache-ratio` отдельный backup-only пул получает `0.2` от device pool (при `--hicache-size 0` — не меньше, чем нужно одному запросу максимальной длины, а при `--disaggregation-decode-host-receive-threshold > 0` — двум); при включённом HiCache — `2.0`. Переполнение малого backup-пула прерывает запрос. `cpu_tensor` расходует RAM по мере числа и длины вытесненных запросов и сильнее зависит от поведения allocator'а. `none` не тратит ни RAM, ни PCIe, но вся уже выполненная работа над вытесненным запросом (prefill на prefill-узле, передача KV, сгенерированные токены) теряется.

## Взаимодействие с другими аргументами

- `--disaggregation-mode decode` обязателен для явного `host_pool`; вне decode-режима `release_req` backup не делает ни при каком значении.
- `--hicache-ratio` / `--hicache-size` задают емкость host pool; исчерпание не переключает backend.
- `--dcp-size > 1` с `host_pool` запрещен.
- `--disaggregation-decode-enable-offload-kvcache` и `host_pool` взаимно исключены: оба строят decode host pool.
- При `--enable-priority-scheduling` для `host_pool` нужен `--disable-priority-preemption`.
- `--disaggregation-decode-host-receive-threshold > 0` требует `host_pool`: с явным `cpu_tensor` старт падает, а `none` и незаданное значение молча переписываются в `host_pool`.

## Типовые проблемы и диагностика

- `...host_pool is only supported on a PD decode server` — выбран не decode-узел.
- `...host_pool does not support --dcp-size > 1` — используйте `cpu_tensor`.
- `Decode host KV buffering requires host_pool retraction` — `cpu_tensor` вместе с `--disaggregation-decode-host-receive-threshold > 0`.
- Предупреждение `retract_decode: aborted request <rid>: Retraction host KV pool exhausted. Aborting the request.` и HTTP 500 у клиента — host pool не вместил backup; увеличьте `--hicache-ratio`/`--hicache-size` или снизьте конкурентность.
- То же предупреждение с текстом `Retracted under decode memory pressure without a KV backup. Retry later.` и HTTP 503 — штатное поведение `none`; частота таких строк равна частоте retraction, и при ее росте нужно разгружать KV-пул decode-узла, а не менять backend.
- Итоговый backend публикуется в runtime config bags и используется в `retraction_backup`/`retraction_restore`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-retraction-backup host_pool --hicache-ratio 1
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-retraction-backup cpu_tensor
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-retraction-backup none
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/disagg.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/common.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- upstream PR #41103 «[PD] Add a `none` decode retraction backup and subclass seams in the PD queues» (коммит `7c5bdb940c` в checkout)
