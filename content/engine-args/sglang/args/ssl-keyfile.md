---
schema: 1
engine: sglang
primaryName: "--ssl-keyfile"
title: "--ssl-keyfile"
summary: Путь к приватному ключу TLS-сертификата. Обязателен вместе с --ssl-certfile и проверяется на существование до загрузки весов; зашифрованный ключ требует --ssl-keyfile-password.
group: serving
related:
  - --ssl-certfile
  - --ssl-keyfile-password
  - --ssl-ca-certs
  - --enable-ssl-refresh
  - --enable-http2
  - --host
  - --tokenizer-worker-num
---

# --ssl-keyfile

## Кратко

`--ssl-keyfile` — приватный ключ к сертификату из `--ssl-certfile`. Аргументы взаимно обязательны: любой без пары отвергается в `__post_init__` с явным сообщением, до того как процесс начнет читать веса.

Отдельный практический момент — права на файл. SGLang проверяет только `os.path.isfile`; недоступный по правам ключ пройдет валидацию и уронит процесс позже, при создании SSL-контекста.

## Оригинальная справка

```text
The file path to the SSL key file.
```

## Паспорт аргумента

- Флаги: `--ssl-keyfile`
- Группа: `serving`
- Тип значения: str — путь к существующему файлу (PEM с приватным ключом)
- Допустимые значения: `choices` нет; `os.path.isfile` проверяется в `_handle_ssl_validation`
- Значение по умолчанию: `None` — TLS выключен
- Эффективное значение: совпадает с заданным, переписывания нет. В отличие от `--ssl-certfile`, на схему внутренних URL не влияет: `ServerArgs.url()` смотрит только на `ssl_certfile`
- Где объявлен: `ServerArgs.ssl_keyfile`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `_handle_ssl_validation` → HTTP-слой (`uvicorn.run(ssl_keyfile=...)` либо `Granian(ssl_key=...)`)

## Что меняет в движке

Единственный потребитель — сетевой слой. Значение уходит:

- в `uvicorn.run(..., ssl_keyfile=server_args.ssl_keyfile, ...)` во всех трех uvicorn-ветках `_setup_and_run_http_server`;
- в `_run_granian_server(..., ssl_key=ssl_keyfile, ...)` при `--enable-http2`;
- в `SSLCertRefresher` (`entrypoints/ssl_utils.py`) при `--enable-ssl-refresh` — там путь отслеживается через `watchfiles.awatch` и при изменении файла контекст перезагружается вызовом `load_cert_chain(cert, key)`.

Валидация в `_handle_ssl_validation` выполняется в таком порядке: сначала парность (`--ssl-keyfile requires --ssl-certfile to be specified as well.`), затем осмысленность спутников (`--ssl-ca-certs` и `--ssl-keyfile-password` без пары cert+key дают отдельные `ValueError`), затем существование каждого файла (`SSL key file not found: '<путь>'. Please check the --ssl-keyfile path.`), затем требование `--enable-ssl-refresh` и совместимость с `--enable-http2`.

## Значения и формат

- PEM-файл с приватным ключом; RSA и EC поддерживаются TLS-библиотекой, SGLang содержимое не разбирает.
- Зашифрованный ключ требует `--ssl-keyfile-password`; без пароля процесс упадет при создании контекста, а не на валидации.
- Проверяется именно файл: каталог или отсутствующий путь дают `ValueError` на этапе `__post_init__`.
- Права доступа не проверяются. Ключ, читаемый только `root`, при запуске от другого пользователя приведет к `PermissionError` в конце старта.
- Ключ и сертификат в одном PEM-файле формально допустимы (можно указать один и тот же путь в оба аргумента), но парность аргументов при этом все равно обязательна.

## Когда использовать

- Только вместе с `--ssl-certfile` и только тогда, когда SGLang сам терминирует TLS.
- Не задавайте, если TLS терминирует обратный прокси: ключ на диске рядом с сервером — лишняя поверхность.

## Влияние на производительность и память

Не влияет на VRAM, RAM и throughput. Единственная заметная величина — стоимость асимметричной операции на TLS-хендшейке, то есть на установку соединения, а не на токен.

## Взаимодействие с другими аргументами

- `--ssl-certfile`: взаимно обязательная пара.
- `--ssl-keyfile-password`: нужен, если ключ зашифрован; без пары cert+key отвергается на валидации.
- `--ssl-ca-certs`: независимый бандл; на разбор ключа не влияет.
- `--enable-ssl-refresh`: перезагружает пару cert+key при изменении файлов на диске; требует обоих аргументов.
- `--enable-http2`: ключ уходит в Granian как `ssl_key`, hot-reload при этом запрещен.
- `--tokenizer-worker-num > 1`: TLS работает, hot-reload отключается с предупреждением.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --ssl-keyfile requires --ssl-certfile to be specified as well.` **Лечение:** задать оба аргумента.
- **Симптом:** `ValueError: SSL key file not found: '<путь>'.` **Причина:** пути нет либо это каталог. **Проверка:** `test -f <путь>`.
- **Симптом:** валидация прошла, а процесс падает в самом конце старта с ошибкой SSL-библиотеки. **Причины:** нет прав на чтение; ключ зашифрован, а `--ssl-keyfile-password` не задан; ключ не соответствует сертификату. **Проверка соответствия:** сравните `openssl x509 -noout -modulus -in <cert> | openssl md5` и `openssl rsa -noout -modulus -in <key> | openssl md5`.
- **Симптом:** после обновления сертификата клиенты продолжают видеть старый. **Причина:** без `--enable-ssl-refresh` контекст загружается один раз при старте. **Лечение:** перезапуск либо `--enable-ssl-refresh`.

## В arriero

Так же, как и для `--ssl-certfile`: менеджер обращается к управляемому инстансу только по `http://` (`instanceBaseUrl` в `apps/api/src/instances/endpoint.ts`), поэтому включение TLS делает инстанс недостижимым для health-пробы и для проксирования. Для инстанса kind `ktransformers` держите TLS выключенным, а шифрование канала обеспечивайте перед самим менеджером.

Второе соображение — секрет на диске. arriero хранит аргументы инстанса в `config/instances/<name>.json`, который может быть под управлением config-git (`docs/CONFIG_GIT.md`). В JSON попадет только путь, но сам файл ключа должен лежать вне каталога конфигурации, иначе он рискует попасть в репозиторий.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey.pem
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey-encrypted.pem --ssl-keyfile-password "$(cat /etc/ssl/sglang/keypass)"
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/ssl_utils.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `apps/api/src/instances/endpoint.ts` (адресация управляемого инстанса), `docs/CONFIG_GIT.md`
