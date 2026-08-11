---
schema: 1
engine: sglang
primaryName: "--grpc-port"
title: "--grpc-port"
summary: Включает нативный gRPC-сервер (Rust-расширение) рядом с обычным HTTP-сервером. По умолчанию выключен; несовместим с `--api-key`, `--use-ray`, `--encoder-only` и `--tokenizer-worker-num > 1`. В legacy-режиме `--smg-grpc-mode` это, наоборот, порт SMG-сервера.
group: serving
related:
  - --smg-grpc-mode
  - --grpc-mode
  - --sidecar
  - --sidecar-args
  - --port
  - --api-key
  - --admin-api-key
  - --tokenizer-worker-num
  - --use-ray
  - --encoder-only
---

# --grpc-port

## Кратко

У аргумента два разных смысла в зависимости от того, включен ли legacy-режим:

- **обычный (HTTP) запуск** — задание порта включает **нативный** gRPC-сервер, который поднимается в том же процессе рядом с HTTP. Оба протокола работают одновременно;
- **`--smg-grpc-mode` / `--grpc-mode`** — это порт legacy SMG-сервера, и его дефолт выводится как `--port + 10000`. Нативный сервер в этом случае не запускается.

Нативный сервер реализован Rust-расширением `sglang.srt.grpc._core`, которое собирается из `rust/sglang-grpc/` при сборке колеса. В колесе без расширения флаг даёт понятную ошибку старта.

## Оригинальная справка

```text
Port for the native gRPC server, started alongside HTTP. Setting this (or SGLANG_GRPC_PORT) enables the native gRPC server; it is off by default. In legacy --smg-grpc-mode this is the SMG server port and defaults to --port + 10000.
```

## Паспорт аргумента

- Флаги: `--grpc-port`
- Группа: `serving`
- Тип значения: целое, номер TCP-порта
- Допустимые значения: `choices` нет; после разбора проверяется диапазон `1 … 65535`
- Значение по умолчанию: `null` — нативный gRPC выключен
- Эффективное значение: переопределяется дважды. (1) Если аргумент не задан, а переменная окружения `SGLANG_GRPC_PORT` установлена, значение берется из нее. (2) В legacy-режиме при всё еще пустом значении подставляется `--port + 10000`
- Где объявлен: `ServerArgs.grpc_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (вывод значения и все проверки совместимости) → `lifespan` HTTP-сервера, запуск нативного gRPC до прогрева

## Что меняет в движке

### Разрешение значения

`_handle_deprecated_args` (`sglang/python/sglang/srt/server_args.py`):

```python
self.grpc_worker_threads = envs.SGLANG_GRPC_WORKER_THREADS.get()
grpc_port_env = envs.SGLANG_GRPC_PORT.get()
if self.grpc_port is None and grpc_port_env is not None:
    self.grpc_port = grpc_port_env
legacy_grpc = self.smg_grpc_mode or self.grpc_mode
if legacy_grpc and self.grpc_port is None:
    self.grpc_port = self.port + 10000
...
native_grpc = self.grpc_port is not None and not legacy_grpc
```

Число рабочих потоков нативного сервера — только через переменную окружения `SGLANG_GRPC_WORKER_THREADS`, CLI-аргумента у нее нет.

### Проверки на старте

При любом непустом `grpc_port`:

- диапазон `1 … 65535`, иначе `ValueError: --grpc-port / SGLANG_GRPC_PORT (N) must be between 1 and 65535`;
- `SGLANG_GRPC_WORKER_THREADS >= 1`.

Только для нативного режима (`native_grpc`):

- `--use-ray` → `ValueError` («the Ray serve launch path does not start the native gRPC server»);
- `--encoder-only` → `ValueError` («encoder disaggregation uses its own server»);
- `--tokenizer-worker-num > 1` → `ValueError` («Native gRPC does not yet support --tokenizer-worker-num > 1»);
- `--api-key` или `--admin-api-key` → `ValueError: --grpc-port is incompatible with --api-key/--admin-api-key: the native gRPC listener bypasses HTTP auth middleware.` Это не придирка: нативный слушатель не проходит через HTTP-middleware аутентификации, поэтому включать его вместе с ключом означало бы открыть неаутентифицированный вход.

И отдельно, в общей валидации:

```python
if not (self.smg_grpc_mode or self.grpc_mode) and self.grpc_port == self.port:
    raise ValueError(f"--grpc-port ({self.grpc_port}) must differ from --port ({self.port})")
```

Проверок на совпадение с `metrics_http_port` и `nccl_port` пока нет — в коде рядом стоит комментарий, что они отложены из-за динамических дефолтов этих портов. Конфликт с ними проявится обычной ошибкой bind'а во время старта.

### Запуск

`lifespan` (`sglang/python/sglang/srt/entrypoints/http_server.py`) поднимает сервер только в single-tokenizer режиме и только вне legacy:

```python
if (getattr(fast_api_app, "is_single_tokenizer_mode", False)
        and server_args.grpc_port is not None
        and not (server_args.smg_grpc_mode or server_args.grpc_mode)):
    grpc_handle = _start_native_grpc_server_for_runtime(...)
    if server_args.sidecar is not None:
        sidecar = start_sidecar(server_args)
```

`_start_native_grpc_server_for_runtime` импортирует `sglang.srt.grpc._core` и при неудаче даёт развернутое сообщение: расширение собирается из `rust/sglang-grpc/` через setuptools-rust, и в колесе без него надо либо ставить другое колесо, либо снять флаг. Успешный запуск печатает `Native gRPC server started on <host>:<port>`. Остановка идет в `finally` того же `lifespan`.

## Значения и формат

- Целое, номер порта. Обязан отличаться от `--port` (вне legacy-режима).
- Не задан — нативный gRPC выключен; ровно то же самое можно включить переменной `SGLANG_GRPC_PORT`.
- Значения «0» и «отключить» нет: `0` отвергается проверкой диапазона.
- В legacy-режиме смысл меняется на порт SMG-сервера; проверка «не равен `--port`» там не выполняется.

## Когда использовать

- Есть клиент, работающий по нативному gRPC SGLang, и нужен он одновременно с HTTP.
- Нужен `--sidecar`: он требует именно нативного gRPC, других вариантов нет.
- **Не используйте**, если на инстансе включена авторизация `--api-key`: старт упадет, и это правильно — иначе gRPC-вход остался бы без проверки.
- **Не используйте** как замену legacy SMG: это разные серверы.

## Влияние на производительность и память

- На VRAM, KV-пул и скорость forward не влияет.
- RAM/потоки хоста: нативный сервер держит пул рабочих потоков (`SGLANG_GRPC_WORKER_THREADS`), плюс собственные буферы Rust-слоя.
- Время старта увеличивается на импорт расширения и bind порта — доли секунды; запуск идет до прогрева, поэтому ошибка расширения обнаруживается рано.
- Трафик по gRPC конкурирует с HTTP за тот же планировщик и ту же память.

## Взаимодействие с другими аргументами

- `--smg-grpc-mode` / `--grpc-mode`: полностью меняют смысл аргумента (порт SMG вместо включения нативного сервера) и отключают нативный путь.
- `--sidecar` / `--sidecar-args`: `--sidecar` без `--grpc-port` (или `SGLANG_GRPC_PORT`) даёт `ValueError: --sidecar requires --grpc-port or SGLANG_GRPC_PORT.`
- `--port`: обязан отличаться; в legacy-режиме служит базой для дефолта `+10000`.
- `--api-key`, `--admin-api-key`, `--use-ray`, `--encoder-only`, `--tokenizer-worker-num`: перечисленные выше жесткие несовместимости.

Для arriero нативный gRPC — дополнительный слушатель: HTTP-проба (`/health`, `/v1/models`) и прокси-форвард продолжают работать штатно. Учитывайте только два момента: порт занимается процессом инстанса и должен быть свободен на хосте, а запрет на `--api-key` означает, что инстанс с включенным нативным gRPC не может защищать свой HTTP ключом — полагайтесь на привязку к `127.0.0.1` и на авторизацию прокси arriero.

## Типовые проблемы и диагностика

- `RuntimeError: Native gRPC extension (sglang.srt.grpc._core) not found in this wheel, but --grpc-port was set.` — колесо собрано без Rust-расширения.
- `ValueError: --grpc-port (N) must differ from --port (M)` — совпали порты.
- `ValueError: --grpc-port is incompatible with --api-key/--admin-api-key` — снимите ключ или флаг.
- `ValueError: Native gRPC does not yet support --tokenizer-worker-num > 1.` — либо `--tokenizer-worker-num 1`, либо без нативного gRPC.
- **Флаг не задан, а gRPC-сервер поднялся** — установлена переменная `SGLANG_GRPC_PORT`; проверьте окружение процесса.
- **Порт указан, сервер не поднялся, ошибок нет** — вы в legacy-режиме (`--smg-grpc-mode`/`--grpc-mode`): там нативный путь отключен целиком.
- Подтверждение: строка `Native gRPC server started on <host>:<port>` при старте; принятое значение — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --port 30000 --grpc-port 40000 --sidecar my_provider.sidecar --sidecar-args '["--sidecar-shutdown-timeout","30"]'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/sidecar.py`
- `sglang/python/sglang/srt/entrypoints/grpc_bridge.py`
- `sglang/python/sglang/launch_server.py`
- `sglang/python/sglang/srt/environ.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
