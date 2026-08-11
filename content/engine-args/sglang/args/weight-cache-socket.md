---
schema: 1
engine: sglang
primaryName: "--weight-cache-socket"
title: "--weight-cache-socket"
summary: Переопределяет путь к unix-сокету демона кеша весов на стороне клиента. У самого демона опции для смены пути нет, поэтому любое значение, кроме выведенного по умолчанию, ведет в «демона нет».
group: model
related:
  - --weight-cache-mode
  - --weight-cache-timeout
  - --tp-size
  - --pp-size
---

# --weight-cache-socket

## Кратко

Аргумент задает путь, по которому движок будет искать unix-сокет демона кеша весов. Он читается только когда `--weight-cache-mode` не равен `off`. Практически важная деталь: демон (`python -m sglang.srt.weight_cache.daemon`) не принимает аналогичной опции и всегда биндит `/tmp/sglang_weight_cache_rank{global_rank}.sock`, поэтому указать другой путь можно только клиенту — и тогда он никого там не найдет. Полезных применений у флага в текущем виде два: явно зафиксировать тот же путь, что выводится автоматически, и указать на сокет демона, запущенного с другим глобальным рангом.

## Оригинальная справка

```text
Unix socket path for weight cache daemon (client mode).If not set, uses /tmp/sglang_weight_cache_rank{global_rank}.sock
```

## Паспорт аргумента

- Флаги: `--weight-cache-socket`
- Группа: `model`
- Тип значения: путь к unix-сокету (`Optional[str]`)
- Допустимые значения: не ограничены
- Значение по умолчанию: `null`
- Эффективное значение: при `null` вычисляется в `maybe_enable_ipc_weight_cache` как `get_socket_path(global_rank)` = `/tmp/sglang_weight_cache_rank{global_rank}.sock`, где `global_rank = tp_size × pp_rank + tp_rank` (`compute_global_rank`). Вычисленное значение записывается прямо в `LoadConfig.weight_cache_socket`
- Где объявлен: `ServerArgs.weight_cache_socket`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: формирование `LoadConfig` перед загрузкой весов (`maybe_enable_ipc_weight_cache`), затем `IpcModelLoader._fetch_from_cache`

## Что меняет в движке

Путь передается в `IpcModelLoader` (`sglang/python/sglang/srt/weight_cache/ipc_loader.py`) и используется в `_fetch_from_cache` строго так:

1. `os.lstat(path)`. `FileNotFoundError` означает «демона нет»: в режиме `client` — откат на диск, в режиме `daemon` — `RuntimeError`.
2. Если объект существует, но `stat.S_ISSOCK` ложно или `st_uid != os.getuid()` — `RuntimeError: Refusing to connect: <path> is not a socket owned by this user.` Это единственная защита от подложенного файла в общем `/tmp`; `lstat`, а не `stat`, чтобы не пойти по симлинку.
3. `connect` с таймаутом сокета 30 секунд (константа в коде, `--weight-cache-timeout` тут ни при чем). `FileNotFoundError` в этот момент трактуется как гонка и снова означает «демона нет»; `ConnectionRefusedError` — жесткая ошибка «демон упал после bind».

Со стороны демона путь не настраивается: `WeightCacheDaemon.__init__` вычисляет `self.socket_path = get_socket_path(...)`, а CLI демона (`--model-path`, `--gpu-id`, `--tp-size`, `--tp-rank`, `--pp-size`, `--pp-rank`, `--dp-size`, `--ep-size`, `--load-format`, `--dtype`, `--quantization`, `--model-loader-extra-config`, `--trust-remote-code`, `--revision`, `--dist-init-method`, `--timeout`, `--force`) опции пути не содержит. Демоны, порождаемые движком в режиме `daemon`, тоже запускаются без нее.

Отсюда следствие, которое надо держать в голове: если задать `--weight-cache-socket /run/my.sock` вместе с `--weight-cache-mode daemon`, движок породит демон, который сядет на путь по умолчанию, а сам пойдет искать сокет по вашему пути — и упадет с `Weight cache daemon not available at /run/my.sock`.

Рядом с сокетом демон держит файл готовности `/tmp/sglang_weight_cache_rank{global_rank}.ready` с записанным PID; его путь этим аргументом тоже не меняется.

## Значения и формат

- Абсолютный путь к unix-сокету. Каталог должен существовать, сам сокет создает демон.
- Путь задается **на процесс движка**, а не на ранг: подстановки `{global_rank}` в пользовательском значении нет. При `--tp-size > 1` все ранги одного процесса-движка пойдут по одному и тому же пути, что для многоранговой конфигурации неверно. Практический вывод: с TP больше 1 не переопределяйте путь.
- Пустая строка ведет себя как ложное значение и приводит к вычислению пути по умолчанию (проверка `if load_config.weight_cache_socket is None` в `maybe_enable_ipc_weight_cache` пропустит пустую строку, но `if load_config.weight_cache_socket` в `get_model_loader` — нет; результат один и тот же).
- Значение игнорируется при `--weight-cache-mode off`.

## Когда использовать

- Демон запущен с явным `--tp-rank`/`--pp-rank`, дающим другой глобальный ранг, чем выведет движок, и надо указать движку правильный сокет. Это единственный сценарий, где переопределение приносит пользу.
- Явная фиксация пути по умолчанию в конфигурации инстанса, чтобы он был виден в командной строке — допустимо, но ничего не меняет.
- Не используйте, чтобы «вынести сокет из `/tmp`»: демон туда не переедет.
- Не используйте с `--tp-size > 1`: один путь на все ранги неверен.

## Влияние на производительность и память

На производительность и память не влияет: значение определяет только адрес подключения. Косвенно неверный путь дорого стоит в режиме `client` — движок молча уйдет на медленную загрузку с диска, потеряв весь смысл кеша.

## Взаимодействие с другими аргументами

- `--weight-cache-mode`: включатель. При `off` аргумент не читается.
- `--weight-cache-timeout`: относится к ожиданию `.ready`-файлов при запуске демонов, а не к подключению по этому сокету (там зашитые 30 секунд).
- `--tp-size`, `--pp-size`: участвуют в формуле глобального ранга, из которой выводится путь по умолчанию.

## Типовые проблемы и диагностика

- `[IpcModelLoader] Daemon socket not found at <path>.` — путь указан неверно либо демон не запущен. В режиме `client` за этим последует `falling back to disk load`, в режиме `daemon` — `RuntimeError`.
- `RuntimeError: [IpcModelLoader] Refusing to connect: <path> is not a socket owned by this user.` — по пути лежит обычный файл, симлинк или чужой сокет. На многопользовательском хосте это ровно тот случай, ради которого проверка и добавлена.
- `RuntimeError: [IpcModelLoader] Daemon socket exists at <path> but refused the connection.` — демон упал после создания сокета; проверьте его лог и удалите устаревшие `.sock`/`.ready` (демон делает это сам при старте, `--force` — чтобы отобрать ранг у живого).
- `RuntimeError: [IpcModelLoader] Failed to connect to daemon at <path>: ...` — прочие ошибки подключения (права, переполненный backlog).
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`); фактически использованный путь всегда виден в тексте перечисленных выше ошибок.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-cache-mode client --weight-cache-socket /tmp/sglang_weight_cache_rank0.sock --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-cache-mode client --mem-fraction-static 0.6
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/weight_cache/protocol.py`
- `sglang/python/sglang/srt/weight_cache/ipc_loader.py`
- `sglang/python/sglang/srt/weight_cache/daemon.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
