---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-host-receive-threshold"
title: "--disaggregation-decode-host-receive-threshold"
summary: Доля занятости device KV-пула decode-узла (0–1), начиная с которой входящий KV новых запросов принимается в host-пул retraction, а не в VRAM. `0` выключает. Ни один встроенный transfer backend это пока не поддерживает, так что ненулевое значение со штатными backend'ами валит старт; это точка расширения для собственных backend'ов.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --disaggregation-decode-retraction-backup
  - --hicache-size
  - --hicache-ratio
  - --hicache-mem-layout
  - --enable-hierarchical-cache
  - --enable-hisparse
  - --enable-pd-role-switch
  - --dcp-size
  - --enable-priority-scheduling
  - --disable-priority-preemption
  - --disaggregation-decode-enable-offload-kvcache
  - --enable-metrics
---

# --disaggregation-decode-host-receive-threshold

## Кратко

В PD-режиме decode-узел сначала выделяет VRAM под KV запроса и только потом просит prefill-узел прислать KV. Когда device-пул почти полон, новые запросы стоят в очереди pre-allocation. Host receive меняет это: при занятости пула выше порога место выделяется в host-пуле — том же HiCache L2-пуле, что использует retraction backend `host_pool`. Prefill присылает KV туда, а когда в VRAM освобождается место, KV загружается на GPU тем же путем, что и при возобновлении вытесненного запроса.

Механизм добавлен upstream PR #40238 «[PD] Add decode host receive for custom transfer backends» как точка расширения. `BaseKVManager.supports_host_destination` и `BaseKVReceiver.supports_host_destination` по умолчанию `False`, и ни один встроенный backend (`mooncake`, `nixl`, `mori`, `ascend`, `fake`) их не переопределяет.

## Оригинальная справка

```text
Device token usage fraction at which incoming KV is received in the decode retraction host pool, excluding evictable cache pages. Range [0, 1]; 0 disables host receive. Size with --hicache-size or --hicache-ratio; requires dense MHA and a transfer backend that supports host destinations. No built-in backend currently supports this.
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-host-receive-threshold`
- Группа: `disagg`
- Тип значения: float
- Допустимые значения: `[0, 1]`; вне диапазона — `ValueError: --disaggregation-decode-host-receive-threshold must be between 0 and 1` из `handle_pd_disaggregation`
- Значение по умолчанию: `0.0` — host receive выключен
- Эффективное значение: само значение не переписывается, но при `> 0` пайплайн меняет соседние поля:
  1. `handle_pd_disaggregation` отвергает HiSparse и role switch (`Decode host receive does not yet support HiSparse or role switching`), отвергает явный `--disaggregation-decode-retraction-backup cpu_tensor` (`Decode host KV buffering requires host_pool retraction`) и объявляет `disaggregation_decode_retraction_backup=host_pool`, перекрывая незаданное значение и `none`;
  2. `handle_hicache` объявляет `hicache_mem_layout=layer_first` и после нормализации layout проверяет, что он таким и остался;
  3. при незаданных `--hicache-ratio`, `--hicache-size` и без `--enable-hierarchical-cache` `resolve_decode_retraction_backup` (`mem_cache/kv_cache_builder.py`) дает host-пулу `max(0.2, 2 × токены одного запроса максимальной длины / размер device-пула)`: один запрос принимается, пока другой вытеснен
- Где объявлен: `python/sglang/srt/arg_groups/fields/disagg.py:Disagg.disaggregation_decode_host_receive_threshold`
- Статус: обычный, новый; на практике — точка расширения без встроенного потребителя
- Этап применения: разбор CLI → пайплайн (`handle_pd_disaggregation`, `handle_hicache`, `handle_cache_compatibility`) → построение KV-кеша (`resolve_decode_retraction_backup`) → создание kv manager в `DecodePreallocQueue` (проверки host-пула и backend'а) → каждый проход pre-allocation и сборки prebuilt-батча

## Что меняет в движке

### Старт decode-узла

В `DecodePreallocQueue._init_kv_manager` (`disaggregation/decode.py`):

- Если в KV-аргументах есть state-пулы (Mamba/SSM) или sidecar-пулы со своей индексацией, старт падает с `ValueError: Host receive requires KV pools sharing the primary indices`. Так код проверяет требование «dense MHA» из справки.
- Host-пул должен вмещать один retraction максимальной длины плюс страницу приема, иначе `ValueError: Host pool must hold a retraction and a receive page; increase --hicache-size or --hicache-ratio`.
- Адреса host-буферов передаются backend'у в `kv_args.host_kv_data_ptrs` / `host_kv_data_lens` / `host_kv_item_lens`.
- Если kv manager не объявляет `supports_host_destination`, старт падает с `ValueError: Transfer backend does not support decode host KV destinations`. Со встроенными backend'ами запуск заканчивается здесь.

### Работа с backend'ом, поддерживающим host-назначения

- Во время pre-allocation для каждого ожидающего запроса (не повторный bootstrap, не fake-передача, receiver поддерживает host) проверяется `full_token_usage >= порог` — доля занятых device-токенов без evictable страниц кеша. Если да, `_pre_alloc_host` выделяет в host-пуле место под промпт, выровненное до страницы, сохраняя резерв на один retraction (при нехватке сначала вытесняет host-узлы radix-дерева). KV запроса оформляется как `RetractionBackup`. Места нет — проход pre-allocation останавливается.
- В `process_decode_queue` меняется порядок: сначала забираются завершенные передачи, и только потом в очередь передачи попадают новые pre-allocated запросы. Так завершенные host-передачи получают VRAM раньше новых.
- При сборке prebuilt-батча KV запроса с backup восстанавливается в VRAM через `restore_kv_cache(..., "host_pool")`.
- Отмена запроса, ожидающего в очереди, освобождает его host backup (`discard_kv_cache_backup`).

### Наблюдаемость

Строка лога decode-батча получает поле `#host-receive-req: N`. В Prometheus появляются `sglang:num_decode_host_receive_queue_reqs` и `sglang:num_decode_host_receive_reqs_total`.

## Значения и формат

- `0` — выключено.
- `0 < x ≤ 1` — порог занятости. `1.0` включает host receive только при полностью занятом device-пуле, малые значения — почти всегда.
- Значение имеет смысл только на decode-сервере. На prefill-узле или без PD принудительный `host_pool` дает `ValueError: --disaggregation-decode-retraction-backup=host_pool is only supported on a PD decode server.`

## Когда использовать

- Только с собственным transfer backend'ом, который реализует host-назначения: `supports_host_destination = True` у manager и receiver и обработку `destination=KVTransferDestination.HOST` в `send_metadata` receiver'а (`disaggregation/base/conn.py`). Цель — не держать KV на prefill-узле в ожидании VRAM на decode при всплесках нагрузки, а парковать его в RAM decode-узла.
- Со встроенными backend'ами не задавайте: старт упадет.
- arriero: PD-развертывание лежит вне модели инстанса (один процесс на инстанс), в квалифицированный профиль (`docs/KTRANSFORMERS_OPERATIONS.md`) не входит.

## Влияние на производительность и память

- **RAM хоста.** Host-пул — закрепленная память; при автоподборе он не меньше двух запросов максимальной длины. Учитывайте его в хостовом бюджете.
- **PCIe и latency.** Принятый на host запрос перед первым decode-шагом копируется H2D, поэтому его первый токен на decode приходит позже, чем при приеме прямо в VRAM.
- **VRAM.** Не растет; цель механизма — не ждать освобождения VRAM.

## Взаимодействие с другими аргументами

- `--disaggregation-mode decode`: обязателен.
- `--disaggregation-transfer-backend`: нужен backend с host-назначениями; встроенные не подходят.
- `--disaggregation-decode-retraction-backup`: принудительно `host_pool`; явный `cpu_tensor` — ошибка старта, `none` и незаданное значение переписываются.
- `--hicache-size`, `--hicache-ratio`: задают емкость host-пула; без них действует автоподбор с удвоенным минимумом.
- `--hicache-mem-layout`: принудительно `layer_first`. Если нормализация layout под хранилище его меняет — `ValueError: The resolved HiCache storage layout '…' cannot share the layer_first decode host pool used by KV transfer`.
- `--enable-hisparse`, `--enable-pd-role-switch`: несовместимы.
- `--dcp-size`, `--enable-priority-scheduling` без `--disable-priority-preemption`, `--disaggregation-decode-enable-offload-kvcache`: ограничения `host_pool` действуют и здесь, потому что backend retraction принудительно `host_pool`.
- `--enable-metrics`: включает Prometheus-метрики host receive.

## Типовые проблемы и диагностика

- **`Transfer backend does not support decode host KV destinations`.** Ожидаемо со встроенными backend'ами; верните `0`.
- **`Host receive requires KV pools sharing the primary indices`.** Модель с рекуррентным состоянием или нестандартными sidecar-пулами; механизм не для нее.
- **`Host pool must hold a retraction and a receive page`.** Увеличьте `--hicache-size` или `--hicache-ratio`.
- **`Decode host KV buffering requires host_pool retraction`.** Уберите явный `--disaggregation-decode-retraction-backup cpu_tensor`.
- **Проверка работы.** `#host-receive-req` в логах decode-батчей и счетчик `sglang:num_decode_host_receive_reqs_total`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-host-receive-threshold 0
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-decode-host-receive-threshold 0.9 --hicache-ratio 1
```

Второй вариант запускается только с собственным transfer backend'ом, поддерживающим host-назначения; со встроенным `mooncake` по умолчанию он завершится ошибкой `Transfer backend does not support decode host KV destinations`.

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/disagg.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/arg_groups/hicache_hook.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_builder.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/python/sglang/srt/disaggregation/base/conn.py`
- `sglang/python/sglang/srt/disaggregation/utils.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- upstream PR #40238 «[PD] Add decode host receive for custom transfer backends» (коммит `efff836911` в checkout)
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
