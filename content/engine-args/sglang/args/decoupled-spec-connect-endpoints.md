---
schema: 1
engine: sglang
primaryName: "--decoupled-spec-connect-endpoints"
title: "--decoupled-spec-connect-endpoints"
summary: JSON-массив bind-эндпойнтов процессов противоположной роли, упорядоченный по их рангу. В отличие от остальных списочных аргументов SGLang, разбирается одним JSON-парсером, а не через `nargs`.
group: disagg
related:
  - --decoupled-spec-role
  - --decoupled-spec-rank
  - --decoupled-spec-bind-endpoint
  - --spec-trace-dir
---

# --decoupled-spec-connect-endpoints

## Кратко

Это адресная книга процесса в сетке decoupled speculative decoding: список входящих (bind) эндпойнтов всех пиров противоположной роли, **упорядоченный по их рангу**, так что индекс в списке и есть ранг адресата. Формат отличается от остальных списочных аргументов SGLang: здесь стоит `type_parser=json_list_type`, поэтому значение читается как одна строка с JSON-массивом, а не как несколько слов через пробел. Аргумент обязателен при ненулевом `--decoupled-spec-role`.

## Оригинальная справка

```text
Peer inbound (bind) endpoints to connect to, ordered by peer rank, for decoupled speculative decoding.
```

## Паспорт аргумента

- Флаги: `--decoupled-spec-connect-endpoints`
- Группа: `disagg`
- Тип значения: JSON-массив строк, передаваемый argparse как **одно** значение (`Optional[List[str]]` с `type_parser=json_list_type`)
- Допустимые значения: `choices` нет; элементы — ZMQ-эндпойнты пиров, обычно `ipc:///tmp/...`
- Значение по умолчанию: `null` (не задан)
- Эффективное значение: сохраняется как список; при сборке `DecoupledSpecIpcConfig` преобразуется в кортеж (`connect_endpoints=tuple(...)`), то есть в конфигурации он неизменяем
- Где объявлен: `ServerArgs.decoupled_spec_connect_endpoints`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг незавершенной функциональности — собранную конфигурацию в checkout'е никто не читает
- Этап применения: разбор CLI (`json_list_type` → `orjson.loads`) → `PortArgs.init_new`, единственное место, где значение читается

## Что меняет в движке

Список пиров вместе с собственным bind-адресом и рангом образует `DecoupledSpecIpcConfig`. Порядок элементов значим: он совпадает с ранговым пространством противоположной роли, объявленным через `--decoupled-spec-rank`. То есть у verifier'а в списке стоят bind-адреса драфтеров в порядке drafter-рангов, у drafter'а — bind-адреса верификаторов в порядке verifier-рангов.

Соответствие «индекс = ранг» согласуется с адресацией в схеме протокола (`speculative/decoupled_spec_io.py`), где каждое сообщение несет явные `src_*_rank` и `dst_*_rank`: `DraftControlBatch(dst_drafter_rank=...)` от верификатора и `DraftTailStreamOutput(src_drafter_rank=..., dst_verifier_rank=...)` обратно. Ключ запроса на драфтерской стороне — `DraftReqKey(src_verifier_rank, request_id)`, потому что `request_id` уникален только внутри своего верификатора.

**Состояние в checkout'е.** Ни один потребитель `PortArgs.decoupled_spec_ipc_config` в дереве не найден; unit-тест модуля называет `decoupled_spec_io` «schema-only IPC layer ... there is no GPU or transport here». На данном коммите подключение к перечисленным адресам не выполняется.

## Значения и формат

- Одно значение — строка с JSON-массивом. В shell ее надо закавычить целиком:

  ```
  --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-drafter-0", "ipc:///tmp/sglang-drafter-1"]'
  ```

- Пробельная форма `--decoupled-spec-connect-endpoints ipc://a ipc://b` **не работает**: `json_list_type` получит первое слово и упадет, потому что `type_parser` отключает автоматический `nargs="+"` для списочных полей.
- Ошибка синтаксиса дает `argparse.ArgumentTypeError: Invalid JSON list: <value>. Please provide a valid JSON list.`
- Парсер не проверяет, что результат — именно массив строк: `'{"a": 1}'` разберется в словарь, а `'5'` — в число, и ошибка проявится позже.
- Одноэлементный список тоже пишется массивом: `'["ipc:///tmp/sglang-verifier-0"]'`.
- Порядок значим; пропуск ранга (дырка в списке) выразить нельзя.
- Адреса должны совпадать с `--decoupled-spec-bind-endpoint` соответствующих процессов символ в символ.

## Когда использовать

- Всегда при задании `--decoupled-spec-role verifier` или `drafter`.
- Список составляется по развертыванию целиком: каждый процесс перечисляет **всех** пиров противоположной роли в порядке их рангов.
- Не путайте со списком своей роли: там процессы друг с другом не общаются.
- Не используйте пробельный синтаксис по аналогии с `--encoder-urls` — у этих двух списочных аргументов разные парсеры.

## Влияние на производительность и память

На текущем коммите — никакого: значение доходит до `PortArgs` и там останавливается. В завершенной схеме длина списка определяет число исходящих ZMQ-соединений процесса; передаются токены и управляющие сообщения, а не KV-кеш, поэтому влияние на память пренебрежимо.

## Взаимодействие с другими аргументами

- `--decoupled-spec-role`: включает требование аргумента и определяет, чьи адреса сюда попадают.
- `--decoupled-spec-rank`: задает позицию **этого** процесса в списках пиров; индекс в этом списке — ранг адресата.
- `--decoupled-spec-bind-endpoint`: адрес, который пиры укажут у себя на позиции ранга этого процесса.
- `--spec-trace-dir`: каталог трассировок decoupled-спекуляции.

## Типовые проблемы и диагностика

- `argparse.ArgumentTypeError: Invalid JSON list: ipc:///tmp/sglang-drafter-0. Please provide a valid JSON list.` — забыты квадратные скобки и кавычки JSON.
- `error: unrecognized arguments: ipc:///tmp/sglang-drafter-1` — попытка перечислить адреса через пробел; аргумент принимает ровно одно значение.
- `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.` — пропущен один из четырех аргументов.
- Сообщения адресуются не тому пиру — рассинхронизирован порядок списков между процессами; движок это не проверяет.
- Принятое значение — в дампе `server_args=` при старте (уже разобранным списком, а не исходной строкой).

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --decoupled-spec-role verifier --decoupled-spec-rank 0 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-verifier-0 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-drafter-0", "ipc:///tmp/sglang-drafter-1"]'
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.2-1B-Instruct --decoupled-spec-role drafter --decoupled-spec-rank 1 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-drafter-1 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-verifier-0"]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/speculative/decoupled_spec_io.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
