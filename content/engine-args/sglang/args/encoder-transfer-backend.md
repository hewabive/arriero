---
schema: 1
engine: sglang
primaryName: "--encoder-transfer-backend"
title: "--encoder-transfer-backend"
summary: Транспорт эмбеддингов от энкодера к языковой стороне EPD. Значение по умолчанию `auto` разрешается в `zmq_to_scheduler` (и в `zmq_to_tokenizer` для Kimi-K3 при TP > 1); `mooncake` дополнительно требует RDMA-настройки.
group: disagg
related:
  - --encoder-only
  - --language-only
  - --encoder-urls
  - --encoder-register-urls
  - --encoder-bootstrap-port
  - --enable-adaptive-dispatch-to-encoder
  - --disaggregation-ib-device
  - --mooncake-ib-device
  - --enable-mm-global-cache
  - --mm-feature-transport
  - --tp-size
  - --grpc-mode
---

# --encoder-transfer-backend

## Кратко

Аргумент определяет, каким путем посчитанные энкодером эмбеддинги попадают в языковой сервер и **в какой его процесс** — в tokenizer manager или сразу в scheduler. От этого зависит и обработка отказа: на пути через tokenizer manager отсутствие эмбеддингов дает клиенту явный `503`, на пути через scheduler запрос может быть тихо обработан локально. Значение должно совпадать на энкодере и на языковой стороне. Значение по умолчанию не литерал, а выражение `ENCODER_TRANSFER_BACKEND_CHOICES[0]`, то есть `auto`, и оно разрешается в конкретный backend в `__post_init__`.

## Оригинальная справка

```text
The backend for encoder disaggregation transfer. Auto selects a model- and TP-aware backend.
```

## Паспорт аргумента

- Флаги: `--encoder-transfer-backend`
- Группа: `disagg`
- Тип значения: str
- Допустимые значения: `auto`, `zmq_to_scheduler`, `zmq_to_tokenizer`, `mooncake`
- Значение по умолчанию: выражение `ENCODER_TRANSFER_BACKEND_CHOICES[0]`, раскрывается в строку `"auto"`
- Эффективное значение: `auto` **всегда** переписывается в `_handle_encoder_disaggregation` функцией `resolve_encoder_transfer_backend(backend, model_arch, tp_size)`: для `KimiK3ForConditionalGeneration` при `--tp-size > 1` — `zmq_to_tokenizer`, во всех остальных случаях — `zmq_to_scheduler`. Разрешение выполняется на любом сервере, но в лог (`Encoder transfer backend auto-resolved to %s for %s at TP%d.`) попадает только при `--encoder-only` или `--language-only`
- Где объявлен: `ServerArgs.encoder_transfer_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_encoder_disaggregation` (разрешение `auto`, валидация IB-устройств при `mooncake`) → создание MM-receiver'а в tokenizer manager и/или scheduler'е → обработка каждого мультимодального запроса

## Что меняет в движке

### `zmq_to_scheduler` (значение после `auto` в типовом случае)

Приемник создается в **scheduler**-процессе (`Scheduler.__init__` при `--language-only` и backend'е из списка `zmq_to_scheduler`/`mooncake`), а элементы запроса рассылаются на энкодеры фоновым потоком. Tokenizer manager запрос не блокирует. Если запрос не был отправлен на энкодер (адаптивная диспетчеризация оставила его локально), tokenizer manager обрабатывает мультимодальные данные сам.

### `zmq_to_tokenizer`

Эмбеддинги возвращаются в **tokenizer manager**, и тот ждет их синхронно в `recv_mm_data` до `SGLANG_ENCODER_REQ_TIMEOUT`. Если запрос был диспетчеризован, а эмбеддинги не пришли, срабатывает `_reject_missing_dispatched_encoder_embedding`: клиент получает `503 The encoder did not return multimodal embeddings. The request was not run locally in language-only mode.` Локальной подмены здесь нет намеренно. Это же значение подставляет `auto` для Kimi-K3 при TP > 1.

### `mooncake`

Эмбеддинги переносятся RDMA-движком mooncake, а не по ZMQ. Следствия:

- включается валидация `--disaggregation-ib-device` (или `--mooncake-ib-device`) даже вне PD-режима — то есть требования к InfiniBand-стеку появляются у чисто энкодерного развертывания;
- на приемной стороне выделяется постоянный GPU-пул под эмбеддинги размером `SGLANG_EMBEDDING_POOL_SIZE_MB` (по умолчанию 4096 МиБ **на TP-ранг**); `0` отключает пул и переводит на регистрацию памяти под каждый запрос. При неудаче аллокации в лог идет `Failed to allocate MooncakeEmbeddingPool, falling back to per-request register`;
- приемник живет в scheduler-процессе, как и у `zmq_to_scheduler`.

Отдельно отметьте: `--encoder-transfer-backend mooncake` управляет **транспортом выходов энкодера** и не имеет отношения к `--enable-mm-global-cache`, который включает глобальный кеш эмбеддингов в Mooncake на энкодере. Эти два механизма независимы.

### Чего аргумент не делает

Он не управляет `--mm-feature-transport`. На `--encoder-only` последний принудительно понижается до `cpu` с явным предупреждением `--mm-feature-transport=... does not control encoder-only output transfer; using cpu for this inactive transport. Select --encoder-transfer-backend for encoder outputs.`

## Значения и формат

- Одно значение из `choices`.
- `auto` — не «оставить как есть», а «выбрать по модели и TP». Реальное значение всегда одно из трех остальных.
- Значение должно быть **одинаковым** на энкодере и на языковой стороне: они реализуют две половины одного протокола, и рассогласование не диагностируется на старте.
- Для gRPC-энкодера (`--encoder-only --grpc-mode`) backend по-прежнему задается этим флагом (в примерах апстрима — `zmq_to_scheduler`), а на получателе дополнительно нужна переменная `SGLANG_ENCODER_MM_RECEIVER_MODE=grpc` и URL вида `grpc://host:port`.
- `mooncake` требует установленного `mooncake-transfer-engine`; отсутствие пакета даст `ImportError` при инициализации приемника.

## Когда использовать

- Оставьте `auto`, если у вас Qwen VL или другая модель из белого списка EPD и вы не упираетесь в транспорт: `zmq_to_scheduler` — штатный путь.
- `zmq_to_tokenizer` — когда важно, чтобы отказ энкодера был явным `503`, а не тихой локальной обработкой. Плата — синхронное ожидание в tokenizer manager.
- `mooncake` — большие эмбеддинги (много изображений высокого разрешения) и настроенная RDMA-инфраструктура; ZMQ через TCP там становится узким местом.
- Не выбирайте `mooncake` без RDMA: валидация IB-устройств сработает и на энкодерном развертывании, и вы получите `RuntimeError: InfiniBand sysfs path not found`.
- Не задавайте разные значения на энкодере и языковом сервере.

## Влияние на производительность и память

- **VRAM.** Заметная плата только у `mooncake`: `SGLANG_EMBEDDING_POOL_SIZE_MB` (4 ГиБ по умолчанию) на TP-ранг приемной стороны. ZMQ-пути постоянного GPU-пула не держат.
- **Сеть.** Эмбеддинги ViT — это тензоры, сопоставимые по объему с изображением после патчей; на многоэлементных запросах разница между RDMA и TCP видна.
- **Latency.** `zmq_to_tokenizer` добавляет синхронное ожидание в tokenizer manager, что при высокой конкурентности сказывается на всех запросах этого воркера; `zmq_to_scheduler` разносит ожидание по scheduler'у.
- **Устойчивость.** `zmq_to_tokenizer` превращает отказ энкодера в быстрый 503; остальные пути могут деградировать к локальной обработке.

## Взаимодействие с другими аргументами

- `--encoder-only` / `--language-only`: значение читается на обоих и должно совпадать.
- `--disaggregation-ib-device` / `--mooncake-ib-device`: при `mooncake` валидируются и используются для выбора HCA.
- `--tp-size`: входит в правило разрешения `auto` (Kimi-K3 при TP > 1) и умножает размер GPU-пула эмбеддингов.
- `--enable-adaptive-dispatch-to-encoder`: определяет, попадет ли запрос в транспорт вообще.
- `--mm-feature-transport`: на энкодере понижается до `cpu`; это другой транспорт, не путайте.
- `--enable-mm-global-cache`: независимый механизм кеширования эмбеддингов, работает при любом значении этого флага.
- `--grpc-mode` / `--smg-grpc-mode` на энкодере: меняют серверную реализацию, но не сам backend транспорта.

## Типовые проблемы и диагностика

- `Encoder transfer backend auto-resolved to zmq_to_scheduler for Qwen3VLForConditionalGeneration at TP1.` — подтверждение разрешения `auto`; смотрите на него, чтобы понять, что реально применилось.
- `503 The encoder did not return multimodal embeddings. The request was not run locally in language-only mode.` — путь `zmq_to_tokenizer`, энкодер не ответил.
- `Encoder embedding not available, falling back to local mm processing` — путь, где локальная обработка разрешена.
- `RuntimeError: InfiniBand sysfs path not found: /sys/class/infiniband` при `mooncake` — RDMA-стека нет; выберите ZMQ-путь.
- `Failed to allocate MooncakeEmbeddingPool, falling back to per-request register` — не хватило VRAM под пул; уменьшайте `SGLANG_EMBEDDING_POOL_SIZE_MB`.
- Сообщения вида `... Raise SGLANG_EMBEDDING_POOL_SIZE_MB.` — пул переполняется под нагрузкой.
- `[<rid>] Embedding recv timeout after <t>s` — общая диагностика для всех путей; таймаут — `SGLANG_ENCODER_REQ_TIMEOUT` (180 c) для ожидания эмбеддингов и `SGLANG_ENCODER_HTTP_TIMEOUT` (1800 c) для HTTP-обмена с энкодером.
- Принятое (уже разрешенное) значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --encoder-only --encoder-transfer-backend zmq_to_scheduler --port 30000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --encoder-urls http://127.0.0.1:30000 --encoder-transfer-backend mooncake --disaggregation-ib-device mlx5_0 --port 30002
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/disaggregation/encode_grpc_server.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
