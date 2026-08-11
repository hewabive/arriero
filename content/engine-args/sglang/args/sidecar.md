---
schema: 1
engine: sglang
primaryName: "--sidecar"
title: "--sidecar"
summary: Запускает произвольный Python-модуль дочерним процессом рядом с сервером и передает ему адрес нативного gRPC через `SGLANG_GRPC_ENDPOINT`. Требует `--grpc-port`, несовместим с legacy SMG-режимом; модуль обязан экспортировать `main(argv)`.
group: serving
related:
  - --sidecar-args
  - --grpc-port
  - --smg-grpc-mode
  - --grpc-mode
  - --host
---

# --sidecar

## Кратко

Это не «функция сервера», а точка расширения жизненного цикла: SGLang берет на себя запуск, надзор и остановку постороннего процесса, единственный контракт которого — импортируемый модуль с функцией `main(argv)` и чтение адреса gRPC из переменной окружения.

Типовое назначение — локальный адаптер/шлюз, который говорит с сервером по нативному gRPC и наружу отдает какой-то свой протокол. В самом дереве SGLang готовых sidecar-модулей нет: аргумент рассчитан на модуль из чужого пакета.

Относитесь к нему как к отдельному режиму развертывания, а не как к настройке обслуживания HTTP.

## Оригинальная справка

```text
Start a locally managed sidecar against the native gRPC server. The selected module must expose main(argv) and read the resolved native gRPC endpoint from SGLANG_GRPC_ENDPOINT. Requires --grpc-port or SGLANG_GRPC_PORT.
```

## Паспорт аргумента

- Флаги: `--sidecar`
- Группа: `serving`
- Тип значения: строка — полное имя импортируемого Python-модуля (например `my_provider.sidecar`)
- Допустимые значения: `choices` нет; любое непустое имя модуля, импортируемое в окружении процесса
- Значение по умолчанию: `null` — sidecar не запускается
- Эффективное значение: `__post_init__` не переопределяет, но валидирует: пустая строка, legacy-режим и отсутствие gRPC-порта — три отдельные ошибки старта
- Где объявлен: `ServerArgs.sidecar`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация) → `lifespan` HTTP-сервера, сразу после запуска нативного gRPC и до прогрева → остановка в `finally` при завершении

## Что меняет в движке

### Проверки на старте

```python
if self.sidecar is not None:
    if not self.sidecar.strip():
        raise ValueError("--sidecar must not be empty.")
    if legacy_grpc:
        raise ValueError(
            "--sidecar requires SGLang's native gRPC server; "
            "it cannot be combined with --smg-grpc-mode/--grpc-mode."
        )
    if self.grpc_port is None:
        raise ValueError("--sidecar requires --grpc-port or SGLANG_GRPC_PORT.")
```

### Запуск

`start_sidecar` (`sglang/python/sglang/srt/entrypoints/sidecar.py`) вызывается из `lifespan` сразу после `_start_native_grpc_server_for_runtime`:

```python
proc = mp.get_context("spawn").Process(
    name=f"sglang_sidecar_{module_name}",
    target=_run_sidecar,
    args=(module_name, sidecar_args, endpoint),
)
```

Метод старта — **spawn**, то есть дочерний процесс не наследует состояние Python-процесса сервера, только окружение. Внутри `_run_sidecar`:

```python
kill_itself_when_parent_died()
os.environ[SGLANG_GRPC_ENDPOINT_ENV] = endpoint
main = getattr(importlib.import_module(module_name), "main")
main(args)
```

Переменная выставляется **до** импорта модуля, поэтому её можно читать на уровне модуля, а не только внутри `main`. Уже существующее значение `SGLANG_GRPC_ENDPOINT` перезаписывается.

### Адрес

`build_sidecar_endpoint` собирает URL из loopback-хоста и `--grpc-port`:

```python
def _loopback_host(host: str) -> str:
    if not host or host == "0.0.0.0":
        return "127.0.0.1"
    if host in ("::", "[::]"):
        return "::1"
    return host
```

То есть `--host 0.0.0.0` даёт `http://127.0.0.1:<grpc_port>`, `--host ::` — `http://[::1]:<grpc_port>`, а конкретный адрес передается как есть. Sidecar всегда ходит на локальный адрес — он «locally managed» по определению.

### Надзор и остановка

За процессом следит `SubprocessWatchdog`. Остановка в `finally` блока `lifespan`: `terminate()`, затем `join(timeout=shutdown_timeout)`, и если процесс жив — `WARNING: Sidecar module did not terminate; killing process tree` плюс `kill_process_tree`. Тайм-аут по умолчанию 45 секунд и настраивается через `--sidecar-args`.

## Значения и формат

- Полное имя модуля в точечной нотации (`пакет.модуль`), не путь к файлу и не имя файла.
- Модуль обязан быть импортируемым в окружении, из которого запущен сервер, и экспортировать **вызываемый** `main`. Иначе — `RuntimeError: --sidecar requires importable module '<name>' with a main(argv) function.` или `… to expose a callable main(argv).`
- Пустая строка и строка из пробелов отвергаются на старте.
- Аргументы модулю передаются отдельно, через `--sidecar-args`; здесь только имя.
- Значения «отключить» нет — аргумент просто не задают.

## Когда использовать

- Есть готовый модуль-адаптер к нативному gRPC SGLang, и вы хотите, чтобы его жизненным циклом управлял сам сервер: один процесс запускается, один останавливается, sidecar не переживает родителя.
- **Не используйте** для запуска произвольных вспомогательных сервисов, не связанных с gRPC этого инстанса: для этого есть штатные средства супервизии.
- **Не используйте** в legacy SMG-режиме — запрещено явной проверкой.
- **Не подходит**, если sidecar должен пережить перезапуск сервера: `kill_itself_when_parent_died` гарантирует обратное.

## Влияние на производительность и память

- Отдельный процесс Python со своей RAM (spawn — полноценный интерпретатор, не форк).
- На VRAM влияет ровно настолько, насколько её потребляет сам модуль; SGLang ничего для него не резервирует.
- Время старта: `spawn` плюс импорт модуля — обычно секунды. Запуск происходит до прогрева, поэтому падение sidecar'а на импорте видно сразу.
- Остановка сервера удлиняется на время `join`, вплоть до `--sidecar-shutdown-timeout` (45 с по умолчанию).

## Взаимодействие с другими аргументами

- `--grpc-port` (или `SGLANG_GRPC_PORT`): обязателен. Именно этот порт попадает в `SGLANG_GRPC_ENDPOINT`.
- `--sidecar-args`: аргументы `main(argv)`; из них SGLang сам вычитывает `--sidecar-shutdown-timeout`. Без `--sidecar` они отвергаются.
- `--smg-grpc-mode` / `--grpc-mode`: несовместимы, ошибка старта.
- `--host`: определяет loopback-адрес в endpoint'е.
- Косвенно наследуются все ограничения `--grpc-port` — в том числе запрет на `--api-key`/`--admin-api-key`.

В arriero управляемый процесс инстанса запускается напрямую (`child_process.spawn`, собственная pgid), а дерево процессов у kind `ktransformers` учитывается целиком (`processTree: "all-descendants"` в дескрипторе движка). Sidecar как дочерний процесс попадает в это дерево и будет остановлен вместе с инстансом; его память ляжет в фактическое потребление инстанса, но в объявленный memory draw (`docs/RESOURCE_MANAGEMENT.md`) она не входит — учитывайте её отдельно.

## Типовые проблемы и диагностика

- `ValueError: --sidecar requires --grpc-port or SGLANG_GRPC_PORT.` — не включен нативный gRPC.
- `ValueError: --sidecar requires SGLang's native gRPC server; it cannot be combined with --smg-grpc-mode/--grpc-mode.` — включен legacy-режим.
- `ValueError: --sidecar must not be empty.` — пустое значение.
- `RuntimeError: --sidecar requires importable module '<name>' with a main(argv) function.` — модуль не импортируется или в нем нет `main`. Проверьте `python -c "import <модуль>"` в том же окружении.
- **Sidecar не видит адрес** — модуль читает `SGLANG_GRPC_ENDPOINT` не из окружения, а из аргументов: адрес передается **только** переменной окружения, в `argv` его нет.
- **Сервер долго завершается** — sidecar не реагирует на `SIGTERM`; в логе `Sidecar module did not terminate; killing process tree`. Уменьшите `--sidecar-shutdown-timeout` или почините обработку сигнала в модуле.
- Подтверждение запуска: `Sidecar module <name> started pid=<pid>`; принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000 --sidecar my_provider.sidecar
```

```bash
SGLANG_GRPC_PORT=40000 python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --sidecar my_provider.sidecar --sidecar-args '["--sidecar-shutdown-timeout","20","--grpc-connections","2"]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/sidecar.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/test/registered/unit/server_args/test_server_args.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/ENGINE_ADAPTERS.md`
