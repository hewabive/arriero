---
schema: 1
engine: sglang
primaryName: "--decoupled-spec-role"
title: "--decoupled-spec-role"
summary: Роль процесса в decoupled speculative decoding: `verifier` считает целевую модель и подтверждает токены, `drafter` генерирует черновик. Значение по умолчанию — строка `"null"`; вместе с ролью обязательны три остальных `--decoupled-spec-*`.
group: disagg
related:
  - --decoupled-spec-rank
  - --decoupled-spec-bind-endpoint
  - --decoupled-spec-connect-endpoints
  - --spec-trace-dir
  - --speculative-algorithm
  - --speculative-draft-model-path
  - --disaggregation-mode
---

# --decoupled-spec-role

## Кратко

Обычное спекулятивное декодирование SGLang живет внутри одного процесса: draft-модель и target-модель считаются одним scheduler'ом. Decoupled speculative decoding разносит их по **разным движкам**, связанным ZMQ-сеткой: черновик генерирует один процесс, проверку и коммит — другой. Этот аргумент объявляет роль конкретного процесса. Как и у `--disaggregation-mode`, значение по умолчанию — реальная строка `"null"`, а не отсутствие значения. Важное предупреждение по состоянию checkout'а: в нем присутствует только схема протокола и сборка конфигурации; scheduler-часть, которая бы этот конфиг читала, еще не выложена (см. ниже).

## Оригинальная справка

```text
Role in decoupled speculative decoding: 'null' disables it, 'verifier' runs the target/verify half, 'drafter' runs the draft half.
```

## Паспорт аргумента

- Флаги: `--decoupled-spec-role`
- Группа: `disagg`
- Тип значения: str; поле объявлено как `Literal["null", "verifier", "drafter"]`, из чего argparse выводит `choices`
- Допустимые значения: `null`, `verifier`, `drafter`. `null` — строка, а не отсутствие значения
- Значение по умолчанию: `"null"`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.decoupled_spec_role`, файл — `sglang/python/sglang/srt/server_args.py`. Обратите внимание: соседние поля датакласса относятся к спекуляции, но группа у всех четырех аргументов — `disagg`
- Статус: обычный флаг незавершенной функциональности — в checkout'е нет ни одного потребителя собранной конфигурации
- Этап применения: `PortArgs.init_new` при подготовке портов и IPC-каналов — единственное место, где значение читается

## Что меняет в движке

`PortArgs.init_new` (`server_args.py`) при `decoupled_spec_role != "null"`:

1. требует, чтобы **все три** остальных аргумента были заданы, иначе `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.`;
2. собирает `DecoupledSpecIpcConfig(bind_endpoint=..., connect_endpoints=tuple(...), rank=int(...))` и кладет его в поле `decoupled_spec_ipc_config` объекта `PortArgs`.

Сама роль в этот объект не входит: она определяет только смысл эндпойнтов (у verifier'а входной канал — PULL результатов от драфтеров, у drafter'а — PULL управляющих сообщений от верификаторов) и то, какую половину протокола процесс реализует.

Протокол описан в `speculative/decoupled_spec_io.py` — это **схема без транспорта**: датаклассы сообщений и вспомогательные структуры реконсиляции.

- От verifier к drafter: `DraftSync` (открыть/переоткрыть запрос, передав промпт и уже закоммиченный префикс), `VerifyCommit` (подтвердить непрерывный сегмент выходных токенов), `DraftClose` (закрыть запрос). Все три упаковываются в `DraftControlBatch`.
- От drafter к verifier: `DraftTailStreamOutput` — по одному черновому токену с `base_committed_len`, по которому verifier понимает, не устарела ли база; батчами это `DraftTailStreamOutputBatch`.
- Идентификация: `DraftReqKey(src_verifier_rank, request_id)` и кодек `draft:<rank>:<request_id>`, потому что `request_id` уникален только внутри своего верификатора.
- Драфтерская сторона копит управляющие сообщения в `DraftControlInbox` и разбирает их между шагами декодирования; `VerifierCommitSegment` склеивает подряд идущие `VerifyCommit` и проверяет их непрерывность.

**Состояние в checkout'е.** `DecoupledSpecIpcConfig` из `PortArgs` в этом коммите не читает никто: поиск по всему дереву находит только объявление, сборку в `PortArgs.init_new` и юнит-тесты. Собственный unit-тест модуля прямо называет `decoupled_spec_io` «schema-only IPC layer ... there is no GPU or transport here». То есть на этом коммите аргументы разбираются, валидируются и складываются в конфигурацию, но роль ни на что не влияет — работающего decoupled-режима в исходниках нет. Проверить на своей сборке: `grep -rn "decoupled_spec_ipc_config" <checkout>/python/sglang`.

## Значения и формат

- Одно значение из `choices`; любое другое отвергает argparse (`SystemExit`).
- `null` эквивалентно незаданному аргументу: ветка в `PortArgs.init_new` не выполняется, три остальных `--decoupled-spec-*` не требуются и не проверяются.
- `verifier` и `drafter` — половины одной сетки, запускаются как отдельные процессы `sglang.launch_server` со своими `--decoupled-spec-bind-endpoint` и списками `--decoupled-spec-connect-endpoints`.
- Ранговое пространство у ролей раздельное: `--decoupled-spec-rank` нумерует процессы **внутри своей роли**.
- Кросс-проверок с `--speculative-algorithm` в `__post_init__` нет: аргументы независимы, и согласованность лежит на операторе.

## Когда использовать

- На этом коммите — только для разработки и тестирования самого протокола. Продакшн-развертывание собрать не из чего: потребителя конфигурации в дереве нет.
- Когда функциональность будет достроена, роль будет иметь смысл там, где draft- и target-модели должны жить на разном железе (например маленький драфтер на слабой карте рядом с большим верификатором).
- Не используйте как замену обычному `--speculative-algorithm`: это разные механизмы, и обычный работает внутри одного процесса.
- Не задавайте `verifier`/`drafter` в рабочей конфигурации «на будущее»: вы получите обязательное требование трех остальных аргументов и никакого выигрыша.

## Влияние на производительность и память

На текущем коммите — никакого: значение доходит до `PortArgs` и там останавливается. Ни один процесс не создается, ни один сокет не биндится, ни один буфер не выделяется. Единственный наблюдаемый эффект — отказ на старте, если заданы не все четыре аргумента.

## Взаимодействие с другими аргументами

- `--decoupled-spec-bind-endpoint`, `--decoupled-spec-connect-endpoints`, `--decoupled-spec-rank`: обязательны при ненулевой роли; отсутствие любого из трех — отказ на старте.
- `--spec-trace-dir`: каталог для трассировок decoupled-спекуляции (объявлен в группе `spec`), логически связан с этой схемой.
- `--speculative-algorithm` и остальные `--speculative-*`: относятся к встроенной спекуляции внутри одного процесса; никаких проверок совместимости с decoupled-ролями в `__post_init__` нет.
- `--disaggregation-mode`: независимая ось. Обе группы аргументов лежат в `disagg`, но это разные топологии — PD делит фазы, decoupled spec делит draft/verify.

## Типовые проблемы и диагностика

- `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.` — задана роль без остальных трех аргументов.
- `argparse: invalid choice: 'bogus'` (выход с кодом 2) — значение вне `choices`.
- Роль задана, все четыре аргумента на месте, сервер стартовал — и ничего не происходит: это ожидаемое поведение на данном коммите, потребителя конфигурации нет.
- Принятое значение — в дампе `server_args=` при старте.
- **В arriero:** даже когда функциональность будет достроена, схема потребует минимум двух процессов со своей ZMQ-сеткой, а менеджер супервизирует один процесс на инстанс (`process/supervisor.ts`) и держит один proxy-endpoint. В квалифицированный профиль (`docs/KTRANSFORMERS_OPERATIONS.md`) она не входит; оставляйте значение по умолчанию.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --decoupled-spec-role verifier --decoupled-spec-rank 0 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-verifier-0 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-drafter-0"]'
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.2-1B-Instruct --decoupled-spec-role drafter --decoupled-spec-rank 0 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-drafter-0 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-verifier-0"]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/decoupled_spec_io.py`
- `sglang/test/registered/unit/spec/test_decoupled_spec_io.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
