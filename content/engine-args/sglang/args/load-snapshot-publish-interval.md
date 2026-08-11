---
schema: 1
engine: sglang
primaryName: "--load-snapshot-publish-interval"
title: "--load-snapshot-publish-interval"
summary: Как часто планировщик публикует снимок своей загрузки в разделяемую память: раз в N итераций decode. Prefill и переход в простой публикуются немедленно. Влияет на свежесть /v1/loads и на качество load-aware диспетчеризации между DP-репликами.
group: observability
related:
  - --dp-size
  - --enable-dp-attention
  - --load-balance-method
  - --nnodes
  - --tokenizer-worker-num
  - --decode-log-interval
---

# --load-snapshot-publish-interval

## Кратко

Планировщик ранга ноль ведет писателя снимков загрузки (`create_load_snapshot_writer`, `sglang/python/sglang/srt/managers/load_snapshot.py`) и на каждом шаге вызывает `Scheduler.publish_load_snapshot`. Аргумент задает, через сколько вызовов подряд снимок реально записывается.

Публикация принудительна в двух случаях, и там интервал не действует:

- шаг является prefill (`force=batch.forward_mode.is_extend()`);
- планировщик уходит в простой (`force=True`).

То есть интервал регулирует только «прореживание» decode-итераций. Читателей у снимка два: `TokenizerManager` для эндпоинта `/v1/loads` и `DataParallelController` для диспетчеризации по загрузке.

## Оригинальная справка

```text
Publish load snapshot to shared memory every N decode iterations. Prefill and idle always publish immediately.
```

## Паспорт аргумента

- Флаги: `--load-snapshot-publish-interval`
- Группа: `observability`
- Тип значения: int (итерации decode)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `15`
- Эффективное значение: оба писателя нормализуют значение как `max(1, publish_interval)`. Значения `0` и отрицательные означают публикацию на **каждой** итерации, а не отключение
- Где объявлен: `ServerArgs.load_snapshot_publish_interval`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация планировщика (создание писателя) → каждый шаг цикла планировщика

## Что меняет в движке

```python
def publish_load_snapshot(self, force: bool = False):
    writer = self.load_snapshot_writer
    if writer is None:
        return
    if not force:
        writer.publish_counter += 1
        if writer.publish_counter < writer.publish_interval:
            return
    writer.publish_counter = 0
    try:
        writer.write(self.load_inquirer.get_loads())
    except Exception as e:
        logger.warning("load snapshot publish failed: %s", e)
```

Писатель создается только на ранге ноль и только в блоке, защищенном `try` — если создать его не удалось, в лог уходит `load snapshot writer init failed: …`, а сервер продолжает работать без снимков (тогда `/v1/loads` и load-aware диспетчеризация останутся без данных).

Транспорта два (`should_use_zmq`):

- **SHM** (по умолчанию) — mmap-файл в `/dev/shm`, по слоту на DP-ранг, запись под `fcntl`-блокировкой. Работает только в пределах одного узла.
- **ZMQ** — при `--enable-dp-attention` вместе с `--nnodes > 1` либо при `SGLANG_LOAD_SNAPSHOT_USE_ZMQ=1`. PUSH-сокет с опцией `CONFLATE`: в буфере хранится только последнее сообщение, отставший читатель получает свежее состояние, а не очередь устаревших.

Содержимое снимка — метрики загрузки ранга (число выполняющихся запросов, токены, пропускная способность); формат — `msgspec.Struct` `LoadSnapshot`.

## Значения и формат

- `15` (по умолчанию) — компромисс: при типичной decode-нагрузке снимок обновляется несколько раз в секунду.
- `1` — публикация на каждой итерации; самое свежее состояние и самая высокая частота записи.
- `0` или отрицательное — то же самое, что `1`, из-за `max(1, …)`. Способа отключить публикацию через этот аргумент нет.
- Большие значения (сотни) имеют смысл только если снимок никто не читает; иначе диспетчеризация начинает работать по устаревшей картине.
- Единица — итерация decode, а не запрос и не секунда: при батче из 32 запросов одна итерация это один токен на каждый из них.

## Когда использовать

- Несколько DP-реплик и `--load-balance-method total_requests` или `total_tokens`: контроллер читает снимок на каждой диспетчеризации, и слишком редкая публикация приводит к перекосу — несколько запросов подряд уходят на реплику, которая уже загружена, но еще не успела об этом сообщить. Уменьшайте интервал.
- Внешняя система опрашивает `/v1/loads` для автоскейлинга или маршрутизации — та же логика.
- На одиночном инстансе без DP менять не нужно: снимок пишется, но фактически никем не используется, кроме `/v1/loads`.

## Влияние на производительность и память

- VRAM не затрагивается.
- Одна публикация — это `msgspec`-кодирование небольшой структуры плюс либо запись в mmap под файловой блокировкой, либо неблокирующая отправка ZMQ. Стоимость мала, но платится в цикле планировщика, то есть в критическом пути decode.
- `--load-snapshot-publish-interval 1` при высокой частоте итераций означает захват `fcntl`-блокировки на каждый шаг; на многоранговой конфигурации это уже измеримо.
- Память: один слот фиксированного размера на DP-ранг в `/dev/shm`.

## Взаимодействие с другими аргументами

- `--dp-size`: число слотов в файле снимков и число писателей; при `dp_size == 1` контроллера данных нет и снимок читает только tokenizer для `/v1/loads`.
- `--load-balance-method`: значения `total_requests` и `total_tokens` делают контроллер активным читателем снимка — именно в этом случае интервал влияет на качество балансировки.
- `--enable-dp-attention` + `--nnodes > 1`: переключение на ZMQ-транспорт.
- `--tokenizer-worker-num` > 1: владельцем ZMQ-сокета становится `MultiTokenizerRouter`, остальные читают из разделяемой памяти.
- `--decode-log-interval`: похожая единица измерения (итерации decode), но другая подсистема — периодические строки лога.

## Типовые проблемы и диагностика

- **Симптом:** `/v1/loads` показывает устаревшие или нулевые значения. **Причина №1:** слишком большой интервал при вялой нагрузке. **Причина №2:** писатель не создался — ищите в логе `load snapshot writer init failed:`.
- **Симптом:** в логе периодически `load snapshot publish failed: …`. **Причина:** ошибка записи (например, переполнен `/dev/shm` или недоступен ZMQ-читатель). **Лечение:** по тексту исключения; сервер при этом продолжает обслуживать запросы.
- **Симптом:** DP-балансировка «слепая», запросы кучкуются. **Причина:** интервал слишком велик относительно скорости диспетчеризации. **Лечение:** уменьшить до 1–5.
- **Симптом:** задали `0`, надеясь отключить публикацию. **Причина:** `max(1, …)`. **Лечение:** отключить нельзя.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `load_snapshot_publish_interval=`; фактическая свежесть проверяется опросом `GET /v1/loads`.

## В arriero

Квалифицированный профиль SGLang-KT в arriero — одиночный инстанс без DP (`docs/KTRANSFORMERS_OPERATIONS.md`, arriero), поэтому читателя, ради которого этот интервал существует, там нет: балансировкой и вытеснением занимается планировщик прокси менеджера по своим данным (`docs/RESOURCE_MANAGEMENT.md`, `docs/API_PROXY_FOUNDATION.md`, arriero), а не по снимкам загрузки движка. Значение по умолчанию менять незачем.

Одна практическая деталь: файл снимков живет в `/dev/shm` и создается процессом инстанса. Он не относится к каталогам arriero (`runtime/`, `data/`) и при удалении инстанса менеджером не убирается — `apps/api/src/instances/delete-cleanup.ts` чистит только каталог слотов и файлы логов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --load-snapshot-publish-interval 15
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --dp-size 4 --load-balance-method total_tokens --load-snapshot-publish-interval 2
```

## Источники

- `sglang/python/sglang/srt/managers/load_snapshot.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`, `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/instances/delete-cleanup.ts`
