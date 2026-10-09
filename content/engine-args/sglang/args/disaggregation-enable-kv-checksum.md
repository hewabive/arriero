---
schema: 1
engine: sglang
primaryName: "--disaggregation-enable-kv-checksum"
title: "--disaggregation-enable-kv-checksum"
summary: Сквозная проверка целостности PD-передачи KV. Prefill считает Adler-32 по KV-страницам (и state-пулам) каждого запроса, decode пересчитывает по полученным и при несовпадении прерывает запрос с HTTP 500. Включать на обоих узлах; цена — один проход по KV запроса на каждой стороне.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --disaggregation-decode-retraction-backup
  - --disaggregation-decode-enable-radix-cache
  - --enable-metrics
---

# --disaggregation-enable-kv-checksum

## Кратко

Передача KV между prefill- и decode-узлами (RDMA через Mooncake, NIXL и другие) не проверяет содержимое на уровне приложения. Испорченная страница KV не вызывает ошибку: запрос продолжается и дает тихо испорченный ответ. Флаг добавляет контрольную сумму от prefill до decode и превращает такую порчу в явный отказ одного запроса.

Это диагностический инструмент для подозрений на железо, драйвер или транспорт, а не режим «на всякий случай»: он стоит одного полного чтения KV запроса на каждой стороне. Аргумент новый (upstream PR #39500 «[PD] Add optional KV transfer checksums»); в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
Compute an Adler-32 checksum over each request's KV pages on prefill and verify it on decode. Enable on both prefill and decode engines. A mismatch aborts the request, or raises in CI. Disabled by default.
```

## Паспорт аргумента

- Флаги: `--disaggregation-enable-kv-checksum`
- Группа: `disagg`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: пайплайн разрешения не трогает; значение читается при создании PD-очередей планировщика
- Где объявлен: `python/sglang/srt/arg_groups/fields/disagg.py:Disagg.disaggregation_enable_kv_checksum`
- Статус: обычный, новый
- Этап применения: создание планировщика в PD-режиме (`MetadataBuffers` с дополнительным буфером) → инициализация `PrefillBootstrapQueue` / `DecodePreallocQueue` (`KvChecksumComputer`) → prefill: отправка последнего чанка KV → decode: фиксация передачи и сборка prebuilt-батча

## Что меняет в движке

### Буфер метаданных

`MetadataBuffers(kv_checksum_enabled=True)` (`disaggregation/utils.py`) добавляет тензор `kv_checksum` формы `(size, 8)` и отдает его как еще один aux-буфер вместе с остальной метаинформацией запроса. Ширина 8 элементов нужна, чтобы строка занимала минимальные для RDMA 64 байта.

### Вычисление

`KvChecksumComputer` (`disaggregation/checksum.py`) получает адреса и размеры элементов всех KV-буферов (`kv_data_ptrs`, `kv_item_lens`) и state-буферов (`state_data_ptrs`, `state_item_lens`) из kv manager. Сумма считается одним запуском JIT-ядра `adler32_strided_checksum` (`sglang/kernels/ops/memory/adler32.py`, исходник `sglang/kernels/jit/csrc/elementwise/adler32_checksum.cuh`) по выбранным страницам. В сумму входят:

- KV-страницы позиций `[0, end)` запроса;
- state-индексы: слот Mamba у `HybridLinearKVPool`; страницы последнего скользящего окна (выровненные до страницы и переведенные в SWA-индексы) у `SWAKVPool`; страницы index-K у `DSATokenToKVPool`.

### Prefill

В `send_kv_chunk` при последнем чанке сумма считается до отправки (`end` — конец extend, не больше длины промпта) и пишется в слот метаданных запроса. Health-check запросы (`rid` с префиксом `HEALTH_CHECK_RID_PREFIX`) получают `0`.

### Decode

- `_commit_transfer_to_req` копирует ожидаемую сумму из слота метаданных в `req.expected_kv_checksum` до освобождения слота. Поэтому запрос можно проверить повторно, в том числе после retraction.
- `get_new_prebuilt_batch` вызывает `_verify_kv_checksums` после восстановления из host backup и до того, как KV попадет в кеш. Для каждого запроса, кроме health-check и случаев с ожидаемым `0`, сумма пересчитывается по `len(origin_input_ids)` позициям.
- При несовпадении пишется `KV checksum mismatch req=<rid> bootstrap_room=<room> expected=0x… got=0x…`. Вне CI запрос прерывается (`prepare_abort(..., "KV checksum mismatch", status_code=500)`), клиент получает ошибку, KV освобождается без вставки в кеш, а при включенных метриках растет `sglang:num_transfer_failed_reqs_total`. Остальные запросы батча продолжают работу.
- В CI (`SGLANG_IS_IN_CI`) несовпадение поднимает `RuntimeError`, и планировщик падает. Не выставляйте эту переменную в эксплуатации.

## Значения и формат

- Флаг без значения.
- Задавайте на **обоих** узлах. С флагом меняется набор aux-буферов метаданных: у включившей стороны их на один больше. Отдельной проверки согласованности между узлами в коде нет, поэтому одностороннее включение — неподдерживаемая конфигурация с непредсказуемым результатом.
- Ожидаемое значение `0` проверку пропускает (так помечены health-check запросы).

## Когда использовать

- Есть подозрение на тихую порчу KV при передаче: ответы decode-узла иногда бессмысленны, хотя тот же запрос без PD отвечает нормально.
- Обкатка новой сети, нового backend'а передачи или прошивки NIC: включить на время проверки и смотреть на `KV checksum mismatch` в логах.
- В штатной эксплуатации без подозрений держать выключенным: проверка стоит пропускной способности памяти и синхронизации на каждом запросе.
- arriero: PD-развертывание вне модели инстанса (один процесс на инстанс) и вне квалифицированного профиля (`docs/KTRANSFORMERS_OPERATIONS.md`).

## Влияние на производительность и память

- **VRAM.** 64 байта на слот метаданных; пренебрежимо.
- **Пропускная способность памяти.** Prefill один раз читает все KV- и state-страницы запроса на последнем чанке, decode — еще раз перед первым шагом. Для длинных промптов это ощутимый объем HBM-трафика.
- **Latency.** `compute` возвращает Python-int, то есть синхронизирует GPU на каждом запросе. На decode проверка идет в потоке планировщика при сборке prebuilt-батча и задерживает его.
- **Время старта.** Первый вызов компилирует JIT-ядро Adler-32.

## Взаимодействие с другими аргументами

- `--disaggregation-mode`: работает только в режимах `prefill` и `decode`; задавайте на обоих.
- `--disaggregation-transfer-backend`: проверка не зависит от backend'а, но сумма передается в aux-метаданных, которые переносит выбранный backend.
- `--disaggregation-decode-retraction-backup`: ожидаемая сумма хранится в запросе, поэтому после retraction и восстановления (в том числе из `host_pool`) KV проверяется заново.
- `--disaggregation-decode-enable-radix-cache`: decode считает сумму по всему промпту, включая префикс из собственного кеша, который по сети не передавался. Совпадение тогда требует побитовой идентичности KV этого префикса на двух узлах. Тесты checkout'а (`test_kv_checksum.py`) это сочетание не покрывают; при совместном использовании сначала проверьте отсутствие ложных несовпадений на своей нагрузке.
- `--enable-metrics`: добавляет счетчик неудачных передач, который растет и при несовпадении суммы.

## Типовые проблемы и диагностика

- **`KV checksum mismatch req=… expected=… got=…` и HTTP 500 у клиента.** KV, полученный decode-узлом, отличается от отправленного. Ищите корреляцию с узлом, NIC или GPU по `bootstrap_room`; проверьте счетчики ошибок RDMA.
- **Несовпадения у всех запросов подряд.** Скорее всего, это конфигурация, а не порча: флаг включен только на одной стороне, или раскладка KV на узлах различается (разные `--tp-size`, `--page-size`, `--kv-cache-dtype`, attention backend).
- **Планировщик упал с `RuntimeError: KV checksum mismatch …`.** В окружении выставлен `SGLANG_IS_IN_CI`.
- **Что включено.** Дамп `server_args=` при старте содержит `disaggregation_enable_kv_checksum=True`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode prefill --disaggregation-enable-kv-checksum --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --disaggregation-mode decode --disaggregation-enable-kv-checksum --port 30001
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/disagg.py`
- `sglang/python/sglang/srt/disaggregation/checksum.py`
- `sglang/python/sglang/srt/disaggregation/prefill.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/python/sglang/srt/disaggregation/utils.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/kernels/ops/memory/adler32.py`
- `sglang/python/sglang/kernels/jit/csrc/elementwise/adler32_checksum.cuh`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/test/registered/unit/disaggregation/test_kv_checksum.py`
- upstream PR #39500 «[PD] Add optional KV transfer checksums» (коммит `1b78083b42` в checkout)
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
