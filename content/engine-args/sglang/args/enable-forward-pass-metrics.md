---
schema: 1
engine: sglang
primaryName: "--enable-forward-pass-metrics"
title: "--enable-forward-pass-metrics"
summary: Публикует по одному msgpack-сообщению на каждую итерацию scheduler'а в ZMQ PUB-сокет для внешнего планировщика (Dynamo). Не Prometheus, `--enable-metrics` не требует, но включает CUDA-таймер вокруг каждого forward.
group: observability
related:
  - --forward-pass-metrics-ipc-name
  - --forward-pass-metrics-worker-id
  - --enable-metrics
  - --dp-size
  - --pp-size
  - --tp-size
  - --kv-events-config
  - --decode-log-interval
---

# --enable-forward-pass-metrics

## Кратко

Forward pass metrics (FPM) — это отдельный от Prometheus канал телеметрии: на каждой итерации scheduler'а формируется структура с длительностью итерации и агрегатами по запланированным и ожидающим запросам, сериализуется через `msgspec.msgpack` и уходит в ZMQ PUB-сокет. Формат зафиксирован по позициям полей под потребителя — планировщик NVIDIA Dynamo, — поэтому менять его нельзя, а несовпадение версий молча портит данные. Опрашивать `/metrics` при этом не нужно: подписчик получает поток в реальном времени. Флаг не требует `--enable-metrics`, но включает `DeviceTimer` — CUDA-события вокруг каждого forward.

## Оригинальная справка

```text
Enable per-iteration forward pass metrics via ZMQ IPC. External consumers (e.g. Dynamo planner) subscribe to the IPC endpoint exposed in server_args.forward_pass_metrics_ipc_name.
```

## Паспорт аргумента

- Флаги: `--enable-forward-pass-metrics`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; парной формы `--no-*` не существует
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным, но **включается не в каждом процессе**: публикатор создается только там, где `attn_tp_rank == 0` и `pp_rank == pp_size - 1` (последняя стадия pipeline). На остальных рангах `scheduler.enable_fpm` остается `False`
- Где объявлен: `ServerArgs.enable_forward_pass_metrics`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `SchedulerMetricsReporter` (`_init_fpm`) → каждая итерация цикла scheduler'а

## Что меняет в движке

### Инициализация

`_init_fpm()` (`sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`):

1. проверяет топологию — `attn_tp_rank == 0` и последняя PP-стадия;
2. берет базовый endpoint из `--forward-pass-metrics-ipc-name`; если он не задан, создает временный файл через `tempfile.NamedTemporaryFile(delete=False)` и складывает `ipc://<путь>` обратно в runtime-контекст;
3. фактический адрес — `f"{base_endpoint}.{dp_rank}"`, то есть **у каждого DP-ранга свой сокет**;
4. поднимает `_FpmPublisherThread` — фоновый демон-поток с `zmq.PUB`, привязанным к этому адресу;
5. подключает репортер к `DeviceTimer`; если таймер еще не создан (переменная `SGLANG_ENABLE_METRICS_DEVICE_TIMER` выключена), создает его специально для FPM;
6. пишет в лог `FPM: ZMQ PUB bound on <endpoint> (dp_rank=…, device_timer=True)`.

### Что публикуется

Структура `ForwardPassMetrics` (`sglang/python/sglang/srt/observability/forward_pass_metrics.py`): `version`, `worker_id`, `dp_rank`, `counter_id` (монотонный номер сообщения), `wall_time` и два вложенных агрегата.

`scheduled_requests` — число prefill-запросов, сумма prefill-токенов, дисперсия длин, сумма уже закешированных KV-токенов, число decode-запросов, сумма и дисперсия длин KV. `queued_requests` — то же по очереди ожидания. Дисперсии считаются алгоритмом Уэлфорда за один проход.

`wall_time` берется из `DeviceTimer` — это накопленное **GPU**-время итерации по CUDA-событиям, а не время по часам; при нулевом накоплении сообщение не отправляется вовсе.

Сообщение уходит как ZMQ-multipart из трех частей: пустой топик, 8-байтовый big-endian номер и msgpack-тело.

### Простой и обратное давление

Если очередь публикатора пуста дольше секунды, поток отправляет heartbeat — сообщение со всеми нулями и `wall_time=0`. Внутренняя очередь ограничена 10 000 сообщений; при переполнении новые **молча отбрасываются** (`except queue.Full: pass`), как и при `zmq.Again` на отправке. То есть медленный подписчик не тормозит scheduler, но и полноты потока не гарантирует — номер `counter_id` позволяет обнаружить пропуски.

При остановке scheduler'а вызывается `_shutdown_fpm()`: поток получает сигнал, ждет до секунды и закрывает сокет.

## Значения и формат

- Флаг без значения; `--enable-forward-pass-metrics true` argparse не примет.
- Отключить после старта нельзя.
- Формат сообщения — позиционный msgpack. Поле `version` (`FPM_VERSION = 1`) обязано совпадать с ожиданиями потребителя: msgspec кодирует по позициям, и рассинхронизация схем не даст ошибки, а тихо испортит значения. Это прямо написано в комментарии к структуре.
- Транспорт — ZMQ PUB, то есть без подтверждений и без ретрансляции: сообщения, отправленные до подписки, теряются.
- Требуется установленный `pyzmq` (входит в зависимости SGLang) и `msgspec`.

## Когда использовать

- Когда снаружи стоит планировщик или роутер, который принимает решения о маршрутизации по мгновенной загрузке движка и не может ждать скрейпа Prometheus. Штатный потребитель — Dynamo planner.
- Когда нужна дисперсия длин запросов в батче: в Prometheus такой метрики нет вообще, а по ней видно, насколько неоднородна нагрузка.
- Не включать, если потребителя нет: поток и CUDA-события будут работать вхолостую, а временный файл сокета останется на диске.
- Не использовать как замену `/metrics` для дашбордов: ни истории, ни агрегации, ни retention здесь нет, и терять сообщения — штатное поведение.
- Не включать «заодно» с `--enable-metrics` ради полноты: механизмы независимы и данные не пересекаются.

## Влияние на производительность и память

- VRAM: не затрагивает, но `DeviceTimer` создает пары `torch.cuda.Event` на каждую итерацию — это дескрипторы на устройстве, а не заметная память.
- Основная цена — именно CUDA-события: `device_timer_ctx` оборачивает forward в `record()`/`record()` и опрашивает готовность через `query()`. Синхронизации хоста здесь нет (интервал забирается только когда событие уже готово), поэтому pipeline не ломается, но постоянные пары событий на каждой decode-итерации — накладные расходы, которых без флага нет. Если `SGLANG_ENABLE_METRICS_DEVICE_TIMER` уже включена, FPM просто подписывается на существующий таймер и ничего не добавляет.
- CPU: на каждой итерации строятся два агрегата с проходом по всем запросам батча и по всей очереди ожидания. При большой очереди это линейно по числу ожидающих запросов **на каждой итерации** — самая заметная часть накладных расходов на длинной очереди.
- RAM хоста: очередь публикатора до 10 000 небольших структур.
- Сериализация и отправка выполняются в отдельном потоке и цикл scheduler'а не блокируют.

## Взаимодействие с другими аргументами

- `--forward-pass-metrics-ipc-name`: задает базовый адрес сокета. Без него адрес генерируется во временном файле и узнать его можно только из лога.
- `--forward-pass-metrics-worker-id`: строка, которая кладется в поле `worker_id` каждого сообщения — так потребитель различает воркеры.
- `--dp-size`: к базовому адресу дописывается `.<dp_rank>`, поэтому подписчику нужно `dp_size` подписок.
- `--pp-size`: публикует только последняя стадия pipeline.
- `--tp-size`: публикует только ранг с `attn_tp_rank == 0`.
- `--enable-metrics`: не требуется и не влияет. Два независимых канала.
- `--kv-events-config`: соседний внешний канал (публикация событий KV-кеша для Dynamo), тоже независимый.
- `--decode-log-interval`: на FPM не влияет — сообщение идет на **каждой** итерации, а не по интервалу.

## Типовые проблемы и диагностика

- В логе нет строки `FPM: ZMQ PUB bound on …` — либо флаг не задан, либо этот процесс не подходит по топологии (не `attn_tp_rank == 0` или не последняя PP-стадия). Ищите строку в логе того ранга, который подходит.
- Подписчик подключился, но ничего не получает — проверьте суффикс `.<dp_rank>` в адресе и то, что подписка оформлена на пустой топик (`setsockopt(zmq.SUBSCRIBE, b"")`). PUB не буферизует для будущих подписчиков.
- Приходят только сообщения со всеми нулями — это heartbeat раз в секунду; движок простаивает.
- В `counter_id` дыры — сообщения отбрасывались из-за переполнения очереди или `zmq.Again`. Ускоряйте потребителя, потери не восстанавливаются.
- Значения полей выглядят как мусор — рассинхронизация схемы между SGLang и потребителем; сверьте `FPM_VERSION`.
- После нештатного завершения в системном temp остается файл сокета — следствие `tempfile.NamedTemporaryFile(delete=False)`; чистится вручную или задается явный путь.
- **В arriero:** этот канал менеджером не используется — arriero принимает решения о маршрутизации по собственному снимку рантайма и лизам domain-coordinator (`docs/API_PROXY_FOUNDATION.md`, `docs/RESOURCE_MANAGEMENT.md`), а не по внешнему потоку от движка. Включать флаг имеет смысл только при наличии стороннего планировщика.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-forward-pass-metrics --forward-pass-metrics-ipc-name ipc:///tmp/sglang-fpm --forward-pass-metrics-worker-id kt-dsv3-a
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --dp-size 2 --enable-forward-pass-metrics --forward-pass-metrics-ipc-name ipc:///tmp/sglang-fpm
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/forward_pass_metrics.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/utils/device_timer.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/RESOURCE_MANAGEMENT.md`
