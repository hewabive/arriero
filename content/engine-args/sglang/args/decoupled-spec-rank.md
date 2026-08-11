---
schema: 1
engine: sglang
primaryName: "--decoupled-spec-rank"
title: "--decoupled-spec-rank"
summary: Номер процесса внутри собственного ролевого пространства decoupled speculative decoding — отдельно нумеруются верификаторы и отдельно драфтеры. Обязателен при ненулевом `--decoupled-spec-role`.
group: disagg
related:
  - --decoupled-spec-role
  - --decoupled-spec-bind-endpoint
  - --decoupled-spec-connect-endpoints
  - --spec-trace-dir
---

# --decoupled-spec-rank

## Кратко

В сетке decoupled speculative decoding у каждого движка есть номер, но пространства номеров у ролей **раздельные**: verifier-ранг 0 и drafter-ранг 0 существуют одновременно и не конфликтуют. Ранг нужен по двум причинам: он задает позицию процесса в упорядоченном списке `--decoupled-spec-connect-endpoints` пиров и он входит в ключ запроса на драфтерской стороне, потому что `request_id` уникален только внутри своего верификатора. Аргумент обязателен при ненулевой роли и не имеет умолчания.

## Оригинальная справка

```text
This engine's rank within its own role space (verifier-rank or drafter-rank) for decoupled speculative decoding.
```

## Паспорт аргумента

- Флаги: `--decoupled-spec-rank`
- Группа: `disagg`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `choices` нет; осмысленны целые ≥ 0, меньшие числа процессов в своей роли
- Значение по умолчанию: `null` (не задан)
- Эффективное значение: совпадает с заданным; преобразуется `int(...)` при сборке `DecoupledSpecIpcConfig`
- Где объявлен: `ServerArgs.decoupled_spec_rank`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг незавершенной функциональности — собранную из него конфигурацию в checkout'е никто не читает
- Этап применения: `PortArgs.init_new` — единственное место, где значение читается

## Что меняет в движке

При `--decoupled-spec-role verifier|drafter` значение попадает в `DecoupledSpecIpcConfig.rank` наряду с bind-эндпойнтом и списком пиров. Роль ранга видна в схеме протокола (`speculative/decoupled_spec_io.py`):

- `DraftReqKey(src_verifier_rank, request_id)` — идентификатор запроса на драфтерской стороне. Комментарий в исходниках объясняет: «The original request_id is only unique within the verifier that owns it. src_verifier_rank keeps the drafter-side request table unambiguous when multiple verifier ranks send work to the same drafter rank.»
- Кодек `build_draft_scheduler_rid` / `parse_draft_scheduler_rid` кодирует ключ в строку `draft:<src_verifier_rank>:<request_id>`; неверный формат дает `ValueError: Invalid decoupled draft scheduler rid: <rid>`.
- Все сообщения протокола несут явные `src_*_rank` и `dst_*_rank`: `DraftSync`, `VerifyCommit`, `DraftClose` — от верификатора к драфтеру; `DraftTailStreamOutput` — обратно.

Второе назначение ранга — позиционное: `--decoupled-spec-connect-endpoints` документирован как список, упорядоченный по рангу пиров, то есть индекс в этом списке и есть ранг адресата.

**Состояние в checkout'е.** Поле `PortArgs.decoupled_spec_ipc_config` в этом коммите не читает ни один потребитель; поиск по дереву находит только объявление, сборку и юнит-тесты. Значение ранга поэтому пока ни на что не влияет за пределами валидации.

## Значения и формат

- Целое число. Проверок на неотрицательность и на согласованность с длиной списка пиров нет.
- Обязателен при ненулевом `--decoupled-spec-role`; его отсутствие вместе с любым другим пропущенным аргументом дает `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.`
- При `--decoupled-spec-role null` значение игнорируется полностью.
- Нумерация начинается с 0 и уникальна **внутри роли**: два процесса-верификатора не могут иметь один ранг, а verifier 0 и drafter 0 — нормальная пара.
- Значение проходит через `int(...)`, поэтому argparse-уровень уже гарантирует целочисленность.

## Когда использовать

- Всегда, когда задан `--decoupled-spec-role verifier` или `drafter`: без него старт не пройдет.
- Ранг назначается развертыванием, а не подбирается: он должен соответствовать позиции процесса в списках пиров у всех остальных участников сетки.
- Не используйте распределенные ранги SGLang (`--node-rank`, TP-ранг) как значение по умолчанию: это независимое пространство.

## Влияние на производительность и память

На текущем коммите — никакого: значение доходит до `PortArgs` и там останавливается. В завершенной схеме ранг влияет только на адресацию сообщений, но не на объем передаваемых данных и не на память.

## Взаимодействие с другими аргументами

- `--decoupled-spec-role`: включает требование этого аргумента и определяет, в каком именно пространстве считается ранг.
- `--decoupled-spec-connect-endpoints`: список упорядочен по рангу пиров, поэтому ранги всей сетки должны быть согласованы между всеми процессами.
- `--decoupled-spec-bind-endpoint`: адрес, который другие процессы укажут в своих списках на позиции этого ранга.
- `--spec-trace-dir`: трассировки decoupled-спекуляции; ранг помогает различать файлы процессов.

## Типовые проблемы и диагностика

- `ValueError: --decoupled-spec-bind-endpoint, --decoupled-spec-connect-endpoints, and --decoupled-spec-rank are required for decoupled speculative decoding.` — пропущен один из четырех аргументов.
- `ValueError: Invalid decoupled draft scheduler rid: <rid>` — рассогласование кодека ключа запроса; появляется при работе с ключами вида `draft:<rank>:<request_id>`.
- Дубли рангов внутри одной роли движок не обнаруживает: рассогласование проявится как неверная адресация, а не как ошибка конфигурации.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --decoupled-spec-role verifier --decoupled-spec-rank 0 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-verifier-0 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-drafter-0"]'
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.2-1B-Instruct --decoupled-spec-role drafter --decoupled-spec-rank 1 --decoupled-spec-bind-endpoint ipc:///tmp/sglang-drafter-1 --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-verifier-0", "ipc:///tmp/sglang-verifier-1"]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/decoupled_spec_io.py`
- `sglang/test/registered/unit/spec/test_decoupled_spec_io.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
