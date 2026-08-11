---
schema: 1
engine: sglang
primaryName: "--decoupled-spec-bind-endpoint"
title: "--decoupled-spec-bind-endpoint"
summary: ZMQ-эндпойнт, который этот движок биндит под свой входящий канал в decoupled speculative decoding: у verifier'а — PULL результатов драфтера, у drafter'а — PULL управляющих сообщений верификатора.
group: disagg
related:
  - --decoupled-spec-role
  - --decoupled-spec-rank
  - --decoupled-spec-connect-endpoints
  - --spec-trace-dir
---

# --decoupled-spec-bind-endpoint

## Кратко

В сетке decoupled speculative decoding каждый процесс держит ровно один входящий сокет и биндит его на адрес из этого аргумента. Смысл канала зависит от роли: verifier принимает по нему черновые токены от драфтеров, drafter — управляющие сообщения (открытие запроса, подтверждение сегмента, закрытие). Тот же адрес другие процессы указывают у себя в `--decoupled-spec-connect-endpoints` на позиции, соответствующей рангу этого движка. Аргумент обязателен при ненулевом `--decoupled-spec-role`.

## Оригинальная справка

```text
ZMQ endpoint this engine binds for its inbound channel in decoupled speculative decoding (verifier: result PULL; drafter: control PULL).
```

## Паспорт аргумента

- Флаги: `--decoupled-spec-bind-endpoint`
- Группа: `disagg`
- Тип значения: str (`Optional[str]`) — ZMQ-эндпойнт
- Допустимые значения: `choices` нет; строка передается в ZMQ как есть. В тестах и в комментарии к полю фигурирует IPC-сетка (`ipc:///tmp/...`); формат `tcp://host:port` ZMQ тоже принимает, но межузловой вариант этой схемой не заявлен
- Значение по умолчанию: `null` (не задан)
- Эффективное значение: совпадает с заданным; попадает в `DecoupledSpecIpcConfig.bind_endpoint` без нормализации
- Где объявлен: `ServerArgs.decoupled_spec_bind_endpoint`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг незавершенной функциональности — собранную конфигурацию в checkout'е никто не читает
- Этап применения: `PortArgs.init_new` — единственное место, где значение читается

## Что меняет в движке

При `--decoupled-spec-role verifier|drafter` строка кладется в `DecoupledSpecIpcConfig.bind_endpoint` вместе с рангом и списком пиров. Смысл канала описан в схеме протокола (`speculative/decoupled_spec_io.py`):

- **verifier** принимает `DraftTailStreamOutput` / `DraftTailStreamOutputBatch` — по одному черновому токену с полем `base_committed_len`, по которому проверяется, не устарела ли база относительно уже закоммиченного префикса;
- **drafter** принимает `DraftControlBatch` — упаковку из `DraftSync` (открыть/переоткрыть запрос с промптом и закоммиченным префиксом), `VerifyCommit` (подтвердить непрерывный сегмент выходных токенов) и `DraftClose` (закрыть запрос). Поток TokenSync складывает их в `DraftControlInbox`, а scheduler драфтера разбирает между шагами декодирования.

Комментарий у поля в исходниках прямо называет транспорт: «Decoupled speculative decoding: draft and verify run as separate engines, currently connected by a ZMQ IPC mesh».

**Состояние в checkout'е.** Ни один потребитель `PortArgs.decoupled_spec_ipc_config` в дереве не найден, а собственный unit-тест `decoupled_spec_io` называет модуль «schema-only IPC layer ... there is no GPU or transport here». Сокет по этому адресу на данном коммите не биндится.

## Значения и формат

- Строка ZMQ-эндпойнта. Валидации формата в SGLang нет — ошибка формата всплывет уже в ZMQ.
- Для IPC каталог должен существовать и быть доступным на запись обоим процессам сетки; типовой вид — `ipc:///tmp/sglang-verifier-0`.
- Адрес обязан быть уникальным для каждого процесса: два движка не могут биндить один эндпойнт.
- Обязателен при ненулевой роли; отсутствие вместе с любым другим пропущенным аргументом дает `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.`
- При `--decoupled-spec-role null` значение игнорируется.
- Это **не** `--dist-init-addr` и не PD bootstrap: сетка decoupled-спекуляции отдельная и с распределенным слоем SGLang не пересекается.

## Когда использовать

- Всегда при задании `--decoupled-spec-role verifier` или `drafter`.
- Адрес назначается развертыванием: он должен фигурировать в `--decoupled-spec-connect-endpoints` всех процессов противоположной роли, на позиции ранга этого движка.
- Не переиспользуйте адреса между запусками, не убедившись, что старые IPC-файлы удалены: ZMQ повесит второй bind на существующий путь.
- Не выносите IPC-путь в общий каталог с непредсказуемыми правами: канал не аутентифицируется.

## Влияние на производительность и память

На текущем коммите — никакого: значение доходит до `PortArgs` и там останавливается. В завершенной схеме это управляющий/потоковый канал небольшого объема (токены и метаданные, не KV-кеш), поэтому выбор IPC против TCP влияет на latency сетки, а не на память.

## Взаимодействие с другими аргументами

- `--decoupled-spec-role`: включает требование аргумента и задает смысл канала.
- `--decoupled-spec-rank`: позиция этого адреса в списках пиров у процессов противоположной роли.
- `--decoupled-spec-connect-endpoints`: зеркальная сторона — там перечисляются bind-адреса пиров.
- `--spec-trace-dir`: каталог трассировок decoupled-спекуляции.

## Типовые проблемы и диагностика

- `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.` — пропущен один из четырех аргументов.
- `zmq.error.ZMQError: Address already in use` — адрес занят другим процессом или остался IPC-файл от прошлого запуска.
- `zmq.error.ZMQError: Invalid argument` — некорректная схема эндпойнта (SGLang строку не проверяет).
- Адрес задан, все четыре аргумента на месте, сервер стартовал — и никакого сокета нет: ожидаемо на данном коммите.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --decoupled-spec-role verifier --decoupled-spec-rank 0 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-verifier-0 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-drafter-0"]'
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.2-1B-Instruct --decoupled-spec-role drafter --decoupled-spec-rank 0 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-drafter-0 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-verifier-0"]' --spec-trace-dir /var/log/sglang/spec
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/decoupled_spec_io.py`
- `sglang/test/registered/unit/spec/test_decoupled_spec_io.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
