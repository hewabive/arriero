---
schema: 1
engine: sglang
primaryName: "--enable-ssl-refresh"
title: "--enable-ssl-refresh"
summary: Следит за файлами сертификата и ключа через watchfiles и перезагружает SSLContext на месте, чтобы ротация не требовала перезапуска. Требует пары cert+key, несовместим с --enable-http2 и молча отключается при нескольких tokenizer-воркерах.
group: serving
related:
  - --ssl-certfile
  - --ssl-keyfile
  - --ssl-ca-certs
  - --ssl-keyfile-password
  - --enable-http2
  - --tokenizer-worker-num
---

# --enable-ssl-refresh

## Кратко

`--enable-ssl-refresh` переводит запуск uvicorn на низкоуровневый путь `uvicorn.Config` + `uvicorn.Server`, чтобы получить доступ к созданному `SSLContext`, и заводит рядом `SSLCertRefresher` — фоновые задачи `watchfiles.awatch`, которые перезагружают сертификат прямо в существующий контекст. Новые TLS-соединения подхватывают свежую пару, старые доживают на прежней.

Ограничений три, и все они проявляются по-разному: без `--ssl-certfile`/`--ssl-keyfile` — ошибка старта; с `--enable-http2` — тоже ошибка старта; с `--tokenizer-worker-num > 1` — молчаливое отключение с предупреждением в логе.

## Оригинальная справка

```text
Enable automatic SSL certificate hot-reloading when cert/key files change on disk. Requires --ssl-certfile and --ssl-keyfile.
```

## Паспорт аргумента

- Флаги: `--enable-ssl-refresh`
- Группа: `serving`
- Тип значения: bool. Объявлен как поле `bool`, поэтому `add_cli_args_from_dataclass` создает `action="store_true"` — парного `--no-enable-ssl-refresh` не существует
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: `False`, если `--tokenizer-worker-num > 1` — там ветка запуска просто пишет предупреждение и идет обычным путем `uvicorn.run(workers=N)`, не создавая `SSLCertRefresher`. Само поле `ServerArgs.enable_ssl_refresh` при этом остается `True`, так что дампу `server_args=` в этом вопросе доверять нельзя
- Где объявлен: `ServerArgs.enable_ssl_refresh`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `_handle_ssl_validation` (парные проверки) → HTTP-слой, выбор ветки запуска в `_setup_and_run_http_server`

## Что меняет в движке

На инференс не влияет. Меняется ровно способ запуска HTTP-сервера.

Обычная ветка — `uvicorn.run(app, ...)`, ничего наружу не отдающая. Ветка с `--enable-ssl-refresh` вместо этого:

1. собирает `uvicorn.Config(app, host, port, root_path, log_level, timeout_keep_alive, loop="uvloop", ssl_keyfile, ssl_certfile, ssl_ca_certs, ssl_keyfile_password)`;
2. вызывает `config.load()` — именно на этом шаге создается `SSLContext`, доступный как `config.ssl`;
3. создает `uvicorn.Server(config)` и запускает его внутри `asyncio.run(_run_with_ssl_refresh())`, где перед `server.serve()` заводится `SSLCertRefresher(config.ssl, keyfile, certfile, ca_certs)`, а в `finally` вызывается `refresher.stop()`.

`SSLCertRefresher` (`entrypoints/ssl_utils.py`) держит одну или две задачи:

- `_watch_cert_key` — `awatch(cert_path, key_path)`, на изменение вызывает `ssl_context.load_cert_chain(cert_path, key_path)` и пишет `SSL cert/key reloaded successfully.`; исключение при загрузке логируется как `Failed to reload SSL cert/key — continuing with previous certificates.` и **не** роняет сервер;
- `_watch_ca` — заводится только при заданном `--ssl-ca-certs`, вызывает `load_verify_locations(ca_path)`.

Важная деталь: `load_cert_chain` вызывается **без** аргумента `password`. Зашифрованный ключ (`--ssl-keyfile-password`) при hot-reload расшифровать нечем, и перезагрузка будет стабильно проваливаться в ветку «continuing with previous certificates».

Ветка `--enable-ssl-refresh` — единственная, где `asyncio.run` вызывается явно вместо `uvicorn.run`; в остальном (root_path, keep-alive, uvloop) параметры совпадают с обычной.

## Значения и формат

- Флаг без значения. Указан — включено, не указан — выключено.
- Отслеживаются именно пути, переданные в аргументах. `watchfiles` работает через inotify: замена файла через `mv` (типичная схема ротации) порождает событие и приводит к перезагрузке; изменение цели симлинка без изменения самого файла может остаться незамеченным — надежнее менять содержимое по тому же пути.
- Требование в справке — не рекомендация: `_handle_ssl_validation` бросает `ValueError: --enable-ssl-refresh requires --ssl-certfile and --ssl-keyfile to be specified.`

## Когда использовать

- Долгоживущий сервер с сертификатами короткого срока (ACME/Let's Encrypt, внутренние CA с ротацией раз в сутки), который сам терминирует TLS. Без hot-reload единственный способ обновить сертификат — перезапуск с полной перезагрузкой модели.
- Не нужен, если TLS терминирует обратный прокси: ротацией занимается он.
- Не включайте с зашифрованным ключом — перезагрузка все равно не сработает, а лог будет наполняться ошибками при каждой ротации.
- Не включайте вместе с `--tokenizer-worker-num > 1`: ожидание не совпадет с поведением, и узнать об этом можно только из строки предупреждения.

## Влияние на производительность и память

Практически нулевое: две фоновые asyncio-задачи с inotify-подпиской на два-три файла. VRAM и время старта не затрагиваются. Единственный неочевидный эффект — сервер запускается через `asyncio.run` вместо `uvicorn.run`, то есть обработка сигналов и завершение идут по чуть иному пути, чем в обычном режиме.

## Взаимодействие с другими аргументами

- `--ssl-certfile` + `--ssl-keyfile`: обязательное условие, проверяется в `_handle_ssl_validation`.
- `--ssl-ca-certs`: включает вторую задачу-наблюдатель за CA-бандлом.
- `--ssl-keyfile-password`: пароль не участвует в перезагрузке — hot-reload зашифрованного ключа не работает.
- `--enable-http2`: `ValueError: --enable-ssl-refresh is not supported with --enable-http2. Granian does not support SSL certificate hot-reloading. Use Uvicorn (the default) or handle certificate rotation externally.`
- `--tokenizer-worker-num > 1`: предупреждение `--enable-ssl-refresh is not supported with multiple tokenizer workers (--tokenizer-worker-num > 1). SSL refresh will be disabled.` и обычный multi-worker запуск.
- `--fastapi-root-path`: в этой ветке `root_path` передается так же, как в обычной.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --enable-ssl-refresh requires --ssl-certfile and --ssl-keyfile to be specified.` **Лечение:** задать пару.
- **Симптом:** `ValueError: --enable-ssl-refresh is not supported with --enable-http2.` **Лечение:** выбрать одно: HTTP/2 или hot-reload.
- **Симптом:** сертификат обновлен, а клиенты получают старый; в логе нет ни `SSL cert/key change detected`, ни `SSL cert/key reloaded successfully.` **Причины:** hot-reload молча отключен из-за `--tokenizer-worker-num > 1`; либо файл не менялся по тому пути, который отслеживается (симлинк). **Проверка:** искать в логе строку `SSL certificate auto-refresh enabled.` — она печатается один раз при успешном включении.
- **Симптом:** в логе `Failed to reload SSL cert/key — continuing with previous certificates.` **Причины:** новый файл битый или несогласован с ключом; либо ключ зашифрован. **Важно:** сервер продолжает работать на старой паре, отказа обслуживания не будет.
- **Симптом:** пакет `watchfiles` не найден. **Причина:** `ssl_utils.py` импортирует его на уровне модуля, но импорт самого модуля выполняется лениво, только внутри ветки hot-reload. **Проверка:** `<env>/bin/python -c "import watchfiles"`.

## В arriero

Неприменим: TLS на управляемом инстансе делает его недостижимым для менеджера — `instanceBaseUrl` (`apps/api/src/instances/endpoint.ts`) строит адрес инстанса безусловно как `http://<host>:<port>`. Соответственно, и ротация сертификатов инстанса не нужна.

Задача, ради которой аргумент существует, в arriero решается на другом уровне: TLS терминирует обратный прокси перед менеджером (`docs/SUBPATH_DEPLOY.md`), и ротацией занимается он, не затрагивая процессы движка.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey.pem --enable-ssl-refresh
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey.pem --ssl-ca-certs /etc/ssl/sglang/internal-ca.pem --enable-ssl-refresh
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/ssl_utils.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- arriero: `apps/api/src/instances/endpoint.ts`, `docs/SUBPATH_DEPLOY.md`
