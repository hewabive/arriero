---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-enable-offload-kvcache"
title: "--disaggregation-decode-enable-offload-kvcache"
summary: Включает на decode-сервере фоновую выгрузку сгенерированного KV в хостовый пул и дальше в L3-хранилище HiCache. Работает только при `--disaggregation-mode decode` и обязательно требует заданного `--hicache-storage-backend`.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-decode-enable-radix-cache
  - --enable-hierarchical-cache
  - --hicache-storage-backend
  - --hicache-storage-backend-extra-config
  - --hicache-ratio
  - --hicache-size
  - --hicache-mem-layout
  - --hicache-io-backend
  - --served-model-name
  - --page-size
---

# --disaggregation-decode-enable-offload-kvcache

## Кратко

На обычном сервере в общий кеш попадает только префикс, посчитанный на prefill. В PD-развертывании decode генерирует свой хвост KV, который иначе просто выбрасывается при завершении запроса. Флаг включает менеджер, который по мере генерации асинхронно копирует этот приращенный KV сначала в хостовый пул, а оттуда в L3-хранилище HiCache — чтобы следующий запрос с тем же продолжением (многоходовой диалог, agentic-цикл) не пересчитывал его заново. Флаг — булев `store_true`, парного `--no-*` нет, и без `--hicache-storage-backend` он отвергается на старте.

## Оригинальная справка

```text
Enable async KV cache offloading on decode server (PD mode).
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-enable-offload-kvcache`
- Группа: `disagg`
- Тип значения: bool (`action="store_true"`, парного `--no-*` нет)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; движок его не переписывает, но при `true` активирует нормализацию hicache-настроек (`_handle_hicache` выполняется, даже если `--enable-hierarchical-cache` не задан)
- Где объявлен: `ServerArgs.disaggregation_decode_enable_offload_kvcache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_hicache` (согласование layout/IO/storage) → `_handle_cache_compatibility` (жесткие проверки) → создание `DecodeKVCacheOffloadManager` в scheduler'е (аллокация хостового пула) → на каждом шаге decode: `check_offload_progress` и `offload_kv_cache` при завершении запроса

## Что меняет в движке

При `true` и `--disaggregation-mode decode` scheduler создает `DecodeKVCacheOffloadManager` (`disaggregation/decode_kvcache_offload_manager.py`), который:

1. **Аллоцирует хостовый пул KV** — `MHATokenToKVPoolHost` или `MLATokenToKVPoolHost`, размер задается `--hicache-ratio`/`--hicache-size`, раскладка — `--hicache-mem-layout`. Это pinned-память хоста, выделяемая один раз на старте.
2. **Поднимает `HiCacheController`** с `--hicache-io-backend`, `--hicache-storage-backend` и `--hicache-storage-backend-extra-config`; имя модели для ключей берется из `--served-model-name`.
3. **Выгружает приращенный KV.** Prefill-сторона выгружает выровненную по страницам часть `origin_input_ids`; decode дописывает то, что сгенерировал сам. Шаг выгрузки — `--page-size`, либо `SGLANG_HICACHE_DECODE_OFFLOAD_STRIDE`, округленный вниз до кратного `page_size`. Пока не накопился целый шаг, ничего не пишется.
4. **Работает асинхронно.** `check_offload_progress()` вызывается на каждой итерации цикла decode (вне зависимости от `--disaggregation-decode-polling-interval`) и добирает завершенные операции; GPU-слоты освобождаются не в момент выгрузки, а при завершении запроса — иначе конкурентное предвыделение переиспользовало бы слоты, которые еще читает текущий запрос.

В логе включение подтверждается строкой `Enable offload kv cache for decode side`.

## Значения и формат

- Флаг без значения. `--disaggregation-decode-enable-offload-kvcache` включает, отсутствие — выключает.
- Два обязательных условия, проверяемых в `_handle_cache_compatibility`:
  - `--disaggregation-mode decode`, иначе `ValueError: The argument disaggregation-decode-enable-offload-kvcache is only supported for decode side.`;
  - непустой `--hicache-storage-backend`, иначе `ValueError: The argument disaggregation-decode-enable-offload-kvcache is only supported when hicache-storage-backend is provided.`
- Тип KV-пула должен быть MHA или MLA; иное — `ValueError: Unsupported KV cache type for decode offload` при создании менеджера.

## Когда использовать

- Многоходовые диалоги и agentic-нагрузка, где следующий запрос продолжает предыдущий: без выгрузки хвост, сгенерированный decode'ом, теряется, и на следующем ходу его придется пересчитать на prefill.
- Общая L3-инфраструктура HiCache (Mooncake-store, файловый или другой backend), уже развернутая под prefill-сторону: decode подключается в тот же ключевой домен.
- Не включайте на однократных запросах без продолжения: выгрузка стоит хостовой памяти и полосы PCIe, а попаданий не будет.
- Не включайте без хранилища: без `--hicache-storage-backend` сервер просто не стартует.

## Влияние на производительность и память

- **RAM хоста.** Основная плата: хостовый KV-пул, размер которого задается `--hicache-ratio` (кратность к устройству) или абсолютным `--hicache-size`. Память pinned, выделяется на старте и не отдается обратно.
- **PCIe.** На каждый накопленный шаг выгрузки идет копирование device→host; на длинных генерациях это постоянный фоновый поток.
- **VRAM.** Прямо не растет; слоты не освобождаются раньше срока специально ради корректности.
- **Latency.** Выгрузка асинхронна и не блокирует шаг decode, но при узком `--hicache-io-backend` или медленном хранилище очередь `ongoing_offload` растет и учитывается планировщиком PP как часть очереди.
- **Выигрыш.** Проявляется на следующем запросе, а не на текущем: сэкономленные токены prefill'а.

## Взаимодействие с другими аргументами

- `--disaggregation-mode decode`: обязателен.
- `--hicache-storage-backend`: обязателен; определяет L3.
- `--hicache-ratio` / `--hicache-size` / `--hicache-mem-layout` / `--hicache-io-backend`: полностью задают хостовый пул и путь копирования. `_handle_hicache` запускается из-за этого флага даже без `--enable-hierarchical-cache` и может переписать layout ради совместимости с backend'ом.
- `--disaggregation-decode-enable-radix-cache`: независимый флаг. Он включает radix-кеш **на устройстве**; в связке с `--enable-hierarchical-cache` еще и активирует `enable_decode_hicache` c проверкой событий HiCache. Выгрузка полезна именно тогда, когда попадания потом кто-то будет использовать.
- `--page-size`: задает минимальный шаг выгрузки.
- `--served-model-name`: входит в ключи хранилища; разные имена не увидят кеш друг друга.
- `--enable-hisparse` и `--enable-unified-memory` в PD имеют собственные ограничения на decode-пул — сверяйтесь с их документами перед комбинированием.

## Типовые проблемы и диагностика

- `ValueError: The argument disaggregation-decode-enable-offload-kvcache is only supported for decode side.` — флаг попал на prefill или на монолитный сервер.
- `ValueError: The argument disaggregation-decode-enable-offload-kvcache is only supported when hicache-storage-backend is provided.` — не задано L3-хранилище.
- `Not enough host memory for request <rid>` в логе — хостовый пул исчерпан, выгрузка для запроса пропущена (запрос при этом обслуживается нормально). Поднимайте `--hicache-ratio`/`--hicache-size` или уменьшайте конкурентность.
- `ValueError: Invalid hicache storage backend extra config JSON: ...` — синтаксис `--hicache-storage-backend-extra-config`.
- Подтверждение включения — `Enable offload kv cache for decode side` в логе scheduler'а.
- Выгрузка «не работает» на коротких ответах — ожидаемо: пока не накопился целый шаг (`--page-size` или `SGLANG_HICACHE_DECODE_OFFLOAD_STRIDE`), запись не начинается.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --disaggregation-decode-enable-offload-kvcache --hicache-storage-backend file --hicache-ratio 2
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --port 30001 --tensor-parallel-size 8 --disaggregation-decode-enable-offload-kvcache --hicache-storage-backend mooncake --hicache-size 64 --hicache-mem-layout page_first
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/decode_kvcache_offload_manager.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/docs/docs/advanced_features/hicache.mdx`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
