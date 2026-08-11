---
schema: 1
engine: sglang
primaryName: "--disaggregation-transfer-backend"
title: "--disaggregation-transfer-backend"
summary: Движок переноса KV-кеша между prefill- и decode-серверами. Значение по умолчанию `mooncake` требует установленного пакета `mooncake-transfer-engine` и RDMA-устройств; `mooncake_tcp` — тот же mooncake, принудительно переведенный на TCP.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-ib-device
  - --disaggregation-bootstrap-port
  - --disaggregation-decode-enable-radix-cache
  - --enable-dsa-cache-layer-split
  - --enable-unified-memory
  - --dcp-size
  - --device
  - --pp-size
  - --enable-hisparse
---

# --disaggregation-transfer-backend

## Кратко

Аргумент выбирает реализацию KV-transfer'а между ролями PD. Значение по умолчанию `mooncake` не означает «работает из коробки»: сам SGLang пакет `mooncake-transfer-engine` не тянет, и его отсутствие превращается в `ImportError` уже после загрузки весов, при инициализации KV-менеджера. Значение задается **на обеих сторонах** и должно совпадать: prefill и decode собирают разные половины одного протокола. Особый случай — `mooncake_tcp`: это не отдельный backend, а mooncake с `MC_FORCE_TCP=1`, переписываемый в `mooncake` еще до всех проверок.

## Оригинальная справка

```text
The backend for disaggregation transfer. Default is mooncake.
```

## Паспорт аргумента

- Флаги: `--disaggregation-transfer-backend`
- Группа: `disagg`
- Тип значения: str
- Допустимые значения: `mooncake`, `nixl`, `ascend`, `fake`, `mori`, `mooncake_tcp` (список `DISAGG_TRANSFER_BACKEND_CHOICES` в `server_args.py`). Список расширяем плагинами через `add_disagg_transfer_backend_choices`, поэтому на конкретной сборке в `--help` может быть больше значений
- Значение по умолчанию: `"mooncake"`
- Эффективное значение: `mooncake_tcp` переписывается в `mooncake` в `handle_pd_disaggregation` с побочными эффектами `os.environ.setdefault("MC_FORCE_TCP", "1")` и `disaggregation_ib_device = None`. Остальные значения проходят как заданы
- Где объявлен: `ServerArgs.disaggregation_transfer_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_pd_disaggregation` (нормализация `mooncake_tcp`, кросс-проверки) → `_handle_encoder_disaggregation` (валидация IB-устройств для mooncake) → `start_disagg_service` на prefill (класс bootstrap-сервера) → `get_kv_class(...)` в scheduler'е при создании KV-менеджера/сендера/ресивера → импорт нативного пакета

## Что меняет в движке

Значение превращается в `TransferBackend` и через `get_kv_class(backend, KVClassType.*)` (`disaggregation/utils.py`) выбирает четверку классов: `KVManager`, `KVSender`, `KVReceiver`, `KVBootstrapServer`. Импорт соответствующего модуля ленивый — он происходит в момент инициализации, а не при разборе CLI, поэтому отсутствие нативной библиотеки всплывает поздно.

- **`mooncake`** — `disaggregation/mooncake/conn.py` поверх `MooncakeTransferEngine` (`distributed/device_communicators/mooncake_transfer_engine.py`). Импортирует `mooncake.engine.TransferEngine`; при отсутствии пакета поднимает `ImportError` с текстом `Please install mooncake by following the instructions at https://kvcache-ai.github.io/Mooncake/...`. По умолчанию использует RDMA (InfiniBand/RoCE) и выбирает HCA по `--disaggregation-ib-device` либо автоматически. Единственный backend, который поддерживает `--enable-unified-memory` под PD и `--enable-dsa-cache-layer-split`.
- **`mooncake_tcp`** — тот же mooncake, но с `MC_FORCE_TCP=1`, из-за чего mooncake ставит `TcpTransport` вместо RDMA. `--disaggregation-ib-device` при этом принудительно обнуляется, а в лог идет `disaggregation transfer backend 'mooncake_tcp' -> mooncake with MC_FORCE_TCP=1 (TCP transport, no RDMA)`. Это единственный штатный путь, не требующий RDMA-железа.
- **`nixl`** — `disaggregation/nixl/conn.py` поверх `nixl._api`. Отсутствие пакета — `ImportError` с ссылкой на репозиторий NIXL. Транспорт плагинный: по умолчанию UCX, переключается переменной `SGLANG_DISAGGREGATION_NIXL_BACKEND` (например `LIBFABRIC`).
- **`mori`** — `disaggregation/mori/conn.py` импортирует `mori.cpp` и `mori.io` **на уровне модуля**, без `try/except`. Пакет обязан быть установлен, иначе получите голый `ModuleNotFoundError: No module named 'mori'` без подсказки.
- **`ascend`** — путь для NPU. `disaggregation/ascend/transfer_engine.py` пытается импортировать `memfabric_hybrid.TransferEngine` и сохраняет ошибку, чтобы поднять ее при конструировании. На `node_rank == 0` дополнительно создается config store по `ASCEND_MF_STORE_URL` (`maybe_create_ascend_config_store`); неверный URL — `RuntimeError: Failed create mf store, invalid ascend_url`.
- **`fake`** — `disaggregation/fake/conn.py`: sender/receiver, которые немедленно рапортуют `KVPoll.Success`, ничего не передавая. Нужен для тестов и профилирования планировщика. На стороне prefill запрещен (`Prefill server does not support 'fake' as the transfer backend`), а на decode дополнительно включает авто-нумерацию `bootstrap_room` в tokenizer manager.

Тонкость, важная для диагностики: даже при реальном backend'е отдельный запрос с `bootstrap_host == "2.2.2.2"` (`FAKE_BOOTSTRAP_HOST`) обслуживается фейковым сендером — так устроен стартовый PD-warmup.

## Значения и формат

- Одно значение из `choices`, регистр значим.
- Значение должно совпадать на prefill и decode. Несовпадение не диагностируется на старте — оно проявится как зависшая передача или падение при рукопожатии.
- `fake` на prefill отвергается ассертом на этапе `__post_init__`.
- Специальных значений `auto`/`none` нет: выключить transfer можно только выключив сам PD-режим.

## Когда использовать

- `mooncake` — если в хосте есть InfiniBand/RoCE и установлен `mooncake-transfer-engine`. Это единственный backend со всеми фичами (unified memory под PD, DSA cache layer split, GPU staging buffer для разнородного TP).
- `mooncake_tcp` — стенд или сеть без RDMA. Ожидайте, что TTFT под нагрузкой упрется в TCP: KV-кеш длинного промпта — это сотни мегабайт на запрос.
- `nixl` — инфраструктура, где уже стоит UCX/LIBFABRIC и NIXL является общим слоем с другими компонентами (например Dynamo).
- `ascend` — только NPU-развертывания с `--device npu`.
- `mori` — AMD-путь; проверьте наличие пакета до запуска, ошибка импорта здесь самая невнятная.
- `fake` — только измерения планировщика decode без реального transfer'а. Не используйте в продакшне: decode получит мусор вместо KV.

## Влияние на производительность и память

- **Сеть — основной ресурс.** Объем на запрос ≈ (длина промпта) × (размер KV на токен на ранг). RDMA (`mooncake`, `nixl/UCX`) выносит это мимо CPU; `mooncake_tcp` грузит хостовые ядра и заметно поднимает TTFT.
- **VRAM.** Сам выбор backend'а память почти не меняет, но `SGLANG_DISAGG_STAGING_BUFFER` (только `mooncake`/`nixl`) добавляет кольцевой пул на decode размером `SGLANG_DISAGG_STAGING_POOL_SIZE_MB` (по умолчанию 4096 МиБ) — это реальный расход.
- **CPU.** Число рабочих потоков transfer'а на TP-ранг задается `SGLANG_DISAGGREGATION_THREAD_POOL_SIZE` (по умолчанию `int(0.75 * os.cpu_count()) // 8`, зажатое в диапазон 4–12), число очередей — `SGLANG_DISAGGREGATION_QUEUE_SIZE` (по умолчанию 4).
- **Время старта.** `mooncake`/`nixl` инициализируют нативный движок и регистрируют память KV-пула; на больших пулах это заметная пауза после загрузки весов.

## Взаимодействие с другими аргументами

- `--disaggregation-mode`: без `prefill`/`decode` значение не используется вообще.
- `--disaggregation-ib-device`: проверяется только при `mooncake` и ненулевом режиме; при `mooncake_tcp` принудительно сбрасывается в `None`.
- `--dcp-size > 1` на decode: требует `mooncake` или `nixl`, иначе `PD decode DCP requires --disaggregation-transfer-backend mooncake or nixl`.
- `--disaggregation-decode-enable-radix-cache`: несовместим с `fake`.
- `--enable-dsa-cache-layer-split`: требует mooncake-семейство (`mooncake` / `mooncake_tcp`), для mori/nixl явно не реализовано.
- `--enable-unified-memory` при ненулевом режиме: только `mooncake`, только `--pp-size 1`, требует ленивую компакцию и несовместим с `--enable-hisparse`.
- `SGLANG_DISAGG_STAGING_BUFFER` (переменная окружения): требует `mooncake` или `nixl`.
- `--device npu` фактически предполагает `ascend` (или `mooncake` с `ENABLE_ASCEND_TRANSFER_WITH_MOONCAKE=true`).

## Типовые проблемы и диагностика

- `ImportError: Please install mooncake by following the instructions at ...` — нет `mooncake-transfer-engine`. Ставится отдельно: `uv pip install mooncake-transfer-engine`.
- `ImportError: Please install NIXL by following the instructions at ...` — нет `nixl`.
- `ModuleNotFoundError: No module named 'mori'` при старте scheduler'а — модуль mori импортируется без обертки, подсказки не будет.
- `RuntimeError: Failed create mf store, invalid ascend_url. With exception ...` — не задан или неверен `ASCEND_MF_STORE_URL`.
- `AssertionError: Prefill server does not support 'fake' as the transfer backend` — `fake` на prefill.
- Передача не начинается, `/health` у обоих серверов 200: чаще всего backend'ы на сторонах разные либо у mooncake не нашлось общего RDMA-устройства. Сверьте `server_args=` в дампах обоих процессов.
- `Transfer thread failed because of ...  Prefill instance with bootstrap_port=... is dead.` в логе decode — prefill упал или потерял сеть.
- **В arriero:** аргумент имеет смысл только внутри PD-развертывания, которое менеджер не супервизирует (менеджер запускает один процесс на инстанс, `process/supervisor.ts`). В обычном инстансе задавать его не нужно.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode prefill --disaggregation-transfer-backend nixl --port 30000
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --disaggregation-transfer-backend mooncake_tcp --port 30001 --base-gpu-id 1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/disaggregation/utils.py`
- `sglang/python/sglang/srt/disaggregation/mooncake/conn.py`
- `sglang/python/sglang/srt/disaggregation/nixl/conn.py`
- `sglang/python/sglang/srt/disaggregation/mori/conn.py`
- `sglang/python/sglang/srt/disaggregation/ascend/transfer_engine.py`
- `sglang/python/sglang/srt/disaggregation/fake/conn.py`
- `sglang/python/sglang/srt/distributed/device_communicators/mooncake_transfer_engine.py`
- `sglang/python/sglang/srt/managers/disagg_service.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
