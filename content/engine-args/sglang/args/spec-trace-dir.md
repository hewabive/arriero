---
schema: 1
engine: sglang
primaryName: "--spec-trace-dir"
title: "--spec-trace-dir"
summary: Каталог для трасс decoupled-режима спекулятивного декодирования (draft и verify как отдельные движки поверх ZMQ). На текущем commit'е checkout'а флаг принимается и сохраняется в `ServerArgs`, но ни один код его не читает — файлы писать некому.
group: spec
related:
  - --decoupled-spec-role
  - --decoupled-spec-bind-endpoint
  - --decoupled-spec-connect-endpoints
  - --decoupled-spec-rank
  - --speculative-algorithm
---

# --spec-trace-dir

## Кратко

Аргумент относится не к обычной спекуляции внутри одного процесса, а к «decoupled» варианту, где верификатор и драфтер — два отдельных движка, связанных ZMQ-мешем (`--decoupled-spec-*`, группа `disagg`). Задумывался он как каталог для отладочных трасс этого обмена. Практическая часть, которую надо знать сегодня: значение проходит разбор CLI и попадает в `ServerArgs`, но потребителя у него в исходниках нет — каталог не создаётся и ничего в него не пишется.

## Оригинальная справка

```text
Directory to write decoupled speculative decoding trace files.
```

## Паспорт аргумента

- Флаги: `--spec-trace-dir`
- Группа: `spec` (притом что остальные флаги decoupled-режима объявлены в группе `disagg`)
- Тип значения: строка — путь к каталогу
- Допустимые значения: не ограничены argparse; существование каталога никто не проверяет
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется ничем
- Где объявлен: `ServerArgs.spec_trace_dir`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме (не `argparse.SUPPRESS`), но фактически заготовка: единственные упоминания поля в исходниках — само объявление и CLI-round-trip тест `test/registered/unit/server_args/test_server_args.py`
- Этап применения: разбор CLI; дальше значение никем не читается

## Что меняет в движке

Ничего. Поле только хранится. Проверяется это одной командой в checkout'е (или в каталоге установленного пакета):

```bash
grep -rn "spec_trace_dir" python/
```

На commit'е, с которого снят extract, находятся ровно два места: объявление в `server_args.py` и проверка round-trip'а в тестах decoupled-флагов. Ни `speculative/decoupled_spec_io.py`, ни планировщик, ни воркеры к нему не обращаются, каталог не создаётся.

Контекст, ради которого поле существует: decoupled-режим (`--decoupled-spec-role verifier|drafter`, `--decoupled-spec-bind-endpoint`, `--decoupled-spec-connect-endpoints`, `--decoupled-spec-rank`) разносит draft и verify по разным процессам и связывает их ZMQ-каналами; протокол этого обмена (`DraftSync`, `VerifyCommit`, идентификаторы `draft:<rank>:<request_id>`) описан в `speculative/decoupled_spec_io.py`. Флаги серверной части появились вместе с протоколом в коммите с темой `[Spec][1/N] Decoupled speculative decoding: IPC protocol + cross-process request id + server flags (#27634)`; писатель трасс в эту порцию не вошёл.

## Значения и формат

- Любая строка. Абсолютный путь, относительный путь, несуществующий каталог — всё принимается одинаково, потому что значение не используется.
- Специальных значений нет; пустая строка так же безобидна.
- Аргумент не связан с `SGLANG_TORCH_PROFILER_DIR` и с каталогом профилей захвата CUDA graph — это разные механизмы.

## Когда использовать

- Только если вы работаете с decoupled-режимом и заранее готовите конфигурацию под будущую порцию функциональности: значение переживёт обновление и начнёт что-то значить, когда писатель трасс появится.
- Во всех остальных случаях не задавать: флаг создаёт ложное впечатление включённой диагностики. Для отладки обычной спекуляции есть `accept len` / `accept rate` в строках `Decode batch`, `avg_spec_accept_length` в `GET /server_info` и переменные окружения семейства `SGLANG_DSPARK_DEBUG_*` у DSPARK.

## Влияние на производительность и память

Нулевое: значение не читается, файлы не открываются, дисковой активности не добавляет.

## Взаимодействие с другими аргументами

- `--decoupled-spec-role` / `--decoupled-spec-bind-endpoint` / `--decoupled-spec-connect-endpoints` / `--decoupled-spec-rank`: смысловая группа, к которой аргумент относится. Ни один из них не делает `--spec-trace-dir` действующим.
- `--speculative-algorithm`: обычная спекуляция трассы не пишет независимо от этого флага.

## Типовые проблемы и диагностика

- «Задал каталог, файлов нет» — ожидаемо, писателя нет. Проверяется командой `grep` выше на своей версии пакета.
- «Каталога не существует, но сервер не ругается» — тоже ожидаемо: значение не валидируется.
- Единственное подтверждение, что аргумент вообще принят: поле `spec_trace_dir` в дампе `server_args=` при старте.
- Перед тем как рассчитывать на этот флаг после обновления, повторите `grep` — появление читателя и есть признак, что функциональность доехала.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --decoupled-spec-role verifier --decoupled-spec-bind-endpoint ipc:///tmp/sglang-verifier --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-drafter"]' --decoupled-spec-rank 0 --spec-trace-dir /var/log/sglang/spec-trace
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --decoupled-spec-role drafter --decoupled-spec-bind-endpoint ipc:///tmp/sglang-drafter --decoupled-spec-connect-endpoints '["ipc:///tmp/sglang-verifier"]' --decoupled-spec-rank 0 --spec-trace-dir /var/log/sglang/spec-trace
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/decoupled_spec_io.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
