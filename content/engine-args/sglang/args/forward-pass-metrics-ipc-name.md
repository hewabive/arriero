---
schema: 1
engine: sglang
primaryName: "--forward-pass-metrics-ipc-name"
title: "--forward-pass-metrics-ipc-name"
summary: Скрытый аргумент: базовый ZMQ-адрес, к которому привязывается PUB-сокет forward pass metrics. Не задан — движок создаст временный путь и напечатает его в лог.
group: observability
related:
  - --enable-forward-pass-metrics
  - --forward-pass-metrics-worker-id
  - --dp-size
  - --kv-events-config
---

# --forward-pass-metrics-ipc-name

## Кратко

Скрытый аргумент (объявлен с `argparse.SUPPRESS`, в `--help` не показывается). Задает базовый адрес ZMQ-сокета, на который публикуются forward pass metrics. Имеет смысл только вместе с `--enable-forward-pass-metrics` — механизм целиком описан там. Фактический адрес привязки — это ваше значение плюс суффикс `.<dp_rank>`, поэтому подписчику при `--dp-size` больше единицы нужно столько же подписок. Если аргумент не задан, движок сам выберет временный путь, и узнать его можно будет только из строки лога.

## Оригинальная справка

```text

```

Справка пуста: аргумент объявлен как `Arg(help=argparse.SUPPRESS)` и в `--help` не выводится.

## Паспорт аргумента

- Флаги: `--forward-pass-metrics-ipc-name`
- Группа: `observability`
- Тип значения: str (`Optional[str]`) — полный ZMQ endpoint вместе со схемой транспорта
- Допустимые значения: `choices` нет; движок значение не валидирует, проверку выполняет `zmq.Socket.bind`
- Значение по умолчанию: `null`
- Эффективное значение: при `null` в `_init_fpm` создается `tempfile.NamedTemporaryFile(delete=False)`, адрес становится `ipc://<путь к этому файлу>` и записывается обратно в runtime-контекст через `get_context().override("metrics_reporter.ipc_endpoint", …)`. К итоговому базовому адресу в любом случае добавляется `.<dp_rank>`
- Где объявлен: `ServerArgs.forward_pass_metrics_ipc_name`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: скрытый (`argparse.SUPPRESS`); контракт может измениться без предупреждения
- Этап применения: конструктор `SchedulerMetricsReporter` (`_init_fpm`), только в процессе с `attn_tp_rank == 0` на последней PP-стадии

## Что меняет в движке

Значение читается один раз, через `get_observability().forward_pass_metrics_ipc_name`, и используется как база для адреса:

```python
base_endpoint = get_observability().forward_pass_metrics_ipc_name
if base_endpoint is None:
    ipc_path = tempfile.NamedTemporaryFile(delete=False).name
    base_endpoint = f"ipc://{ipc_path}"
    get_context().override("metrics_reporter.ipc_endpoint", forward_pass_metrics_ipc_name=base_endpoint)
endpoint = f"{base_endpoint}.{self.scheduler._fpm_dp_rank}"
```

Дальше `endpoint` уходит прямо в `zmq.Socket.bind` внутри `_FpmPublisherThread`. Никакой нормализации нет: что написали, то и будет привязано (с добавленным суффиксом ранга).

Обратная запись в контекст выполняется в **scheduler**-процессе, поэтому автоматически выбранный адрес виден только там. Единственный надежный способ его узнать — строка лога, которая печатается сразу после привязки:

```text
FPM: ZMQ PUB bound on ipc:///tmp/tmpab12cd34.0 (dp_rank=0, device_timer=True)
```

Если подписчик запускается автоматикой, а не человеком, адрес надо задавать явно — на автогенерацию полагаться нельзя.

## Значения и формат

- Значение должно быть **полным** ZMQ endpoint'ом со схемой: `ipc:///tmp/sglang-fpm`, `tcp://127.0.0.1:35000`. Голый путь `/tmp/sglang-fpm` `bind` отвергнет.
- К значению всегда дописывается `.<dp_rank>`. Для `ipc://` это дает разные файлы сокетов; для `tcp://` это даст `tcp://127.0.0.1:35000.0`, что `bind` не примет — TCP-транспорт с этим аргументом практически неприменим при любом `dp_size`.
- Каталог для `ipc://` должен существовать и быть доступен на запись процессу scheduler'а; сам файл сокета создает ZMQ.
- Пустая строка — не то же самое, что незаданный аргумент: `""` пройдет проверку `is None` и `bind("" + ".0")` упадет.
- Специальных значений (`auto`, `none`) нет.
- Значение полностью игнорируется без `--enable-forward-pass-metrics`, а также в процессах, не подходящих по топологии.

## Когда использовать

- Всегда, когда FPM включены и подписчик стартует отдельно: фиксированный путь избавляет от чтения лога и от гонки «подписчик поднялся раньше, чем стал известен адрес».
- Когда несколько инстансов SGLang живут на одном хосте: без явных путей каждый возьмет свой временный файл, но привязать их к предсказуемым именам (`ipc:///run/sglang/fpm-<инстанс>`) проще для эксплуатации.
- Не трогать, если FPM не используются: аргумент скрытый, в `--help` установленной сборки его может не быть, и добавление его в аргументы инстанса только усложняет конфигурацию.
- Не выбирать каталог, который чистится по расписанию во время работы сервера: удаление файла сокета оборвет доставку без ошибки на стороне publisher'а.

## Влияние на производительность и память

- На производительность не влияет: значение используется один раз при привязке сокета. Вся стоимость механизма описана в `--enable-forward-pass-metrics`.
- На память не влияет.
- Единственный побочный эффект по ресурсам — файл в файловой системе: при автогенерации `tempfile.NamedTemporaryFile(delete=False)` оставляет файл в системном temp даже после штатной остановки сервера.

## Взаимодействие с другими аргументами

- `--enable-forward-pass-metrics`: без него аргумент не читается вовсе.
- `--dp-size`: определяет число сокетов, `.0`, `.1`, … — по одному на DP-ранг.
- `--pp-size` / `--tp-size`: определяют, какой именно процесс выполнит привязку (последняя PP-стадия, `attn_tp_rank == 0`).
- `--forward-pass-metrics-worker-id`: вторая половина «адресации» — по нему потребитель различает воркеры внутри одного потока сообщений.
- `--kv-events-config`: другой внешний канал со своей конфигурацией транспорта; общего с этим аргументом ничего не имеет.

## Типовые проблемы и диагностика

- `zmq.error.ZMQError: Invalid argument` при старте scheduler'а — адрес без схемы транспорта либо `tcp://…` с дописанным `.0`.
- `zmq.error.ZMQError: Address already in use` — по этому пути уже привязан сокет другого инстанса; выберите другой путь или удалите остаток файла.
- `Permission denied` — каталог для `ipc://` недоступен процессу на запись. Учитывайте, что при NUMA-режиме `bind` в arriero процесс запускается в cgroup, но пользователь тот же.
- Подписчик молчит, хотя строка `FPM: ZMQ PUB bound on …` в логе есть — почти всегда забыт суффикс `.<dp_rank>`.
- Аргумент задан, но в `--help` установленной сборки его нет — это нормально для скрытого аргумента; убедиться, что сборка его принимает, можно только пробным запуском (`unrecognized arguments` в случае отсутствия).
- **В arriero:** каталог аргументов инстанса строится из `--help` установленного движка (`docs/CASE_PHANTOM_HELP_ARGS.md`), а скрытые аргументы в `--help` не попадают. Добавлять его придется как свободный аргумент, и preflight не сможет подтвердить его существование.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-forward-pass-metrics --forward-pass-metrics-ipc-name ipc:///tmp/sglang-fpm
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --dp-size 2 --enable-forward-pass-metrics --forward-pass-metrics-ipc-name ipc:///run/user/1000/sglang-fpm --forward-pass-metrics-worker-id kt-dsv3-a
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/observability/forward_pass_metrics.py`
- `sglang/python/sglang/srt/runtime_context.py`
- arriero: `docs/CASE_PHANTOM_HELP_ARGS.md`
