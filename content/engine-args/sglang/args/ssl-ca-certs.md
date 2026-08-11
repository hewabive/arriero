---
schema: 1
engine: sglang
primaryName: "--ssl-ca-certs"
title: "--ssl-ca-certs"
summary: CA-бандл, который SGLang использует прежде всего как verify= для собственных внутренних HTTPS-запросов; без --ssl-certfile и --ssl-keyfile аргумент отвергается на старте.
group: serving
related:
  - --ssl-certfile
  - --ssl-keyfile
  - --ssl-keyfile-password
  - --enable-ssl-refresh
  - --enable-http2
  - --skip-server-warmup
---

# --ssl-ca-certs

## Кратко

`--ssl-ca-certs` — файл с доверенными CA. У него две роли, и первая важнее второй.

1. **Проверка собственного сертификата внутренним клиентом.** `ServerArgs.ssl_verify()` возвращает этот путь как значение `verify=` для `requests`, которым сервер обращается сам к себе на warmup. Без него при включенном TLS верификация внутренних запросов **отключается** (`verify=False`) с однократным предупреждением в логе.
2. **Передача в ASGI-сервер.** Значение уходит в `uvicorn.run(ssl_ca_certs=...)` и в Granian как `ssl_ca`. При этом Granian получает рядом `ssl_client_verify=False` с явным комментарием в коде «MTls is not supported», то есть на HTTP/2-пути проверка клиентских сертификатов заведомо не включается.

Без `--ssl-certfile` и `--ssl-keyfile` аргумент не просто бесполезен — он приводит к ошибке на старте.

## Оригинальная справка

```text
The CA certificates file.
```

## Паспорт аргумента

- Флаги: `--ssl-ca-certs`
- Группа: `serving`
- Тип значения: str — путь к существующему файлу (PEM-бандл)
- Допустимые значения: `choices` нет; `os.path.isfile` проверяется в `_handle_ssl_validation`
- Значение по умолчанию: `None` — внутренний клиент использует системный CA-бандл (`verify=True`), пока TLS выключен, и `verify=False`, когда TLS включен
- Эффективное значение: совпадает с заданным. Переписывания нет, но поведение `ssl_verify()` меняется скачкообразно: `ssl_ca_certs` → путь; иначе если задан `ssl_certfile` → `False` плюс предупреждение; иначе → `True`
- Где объявлен: `ServerArgs.ssl_ca_certs`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `_handle_ssl_validation` → HTTP-слой и warmup-клиент

## Что меняет в движке

### Внутренний клиент

`_execute_server_warmup` (`entrypoints/http_server.py`) берет `ssl_verify = server_args.ssl_verify()` и передает его в каждый `requests.get`/`requests.post` к собственному адресу — сначала опрос `/model_info`, затем warmup-генерация. Тот же механизм используется в `_send_disaggregation_warmup_requests`. Это и есть основной сценарий, ради которого аргумент существует: при самоподписанном сертификате без CA-бандла сервер вынужден ходить к себе без проверки, и в логе появляется

```text
SSL is enabled but --ssl-ca-certs was not provided. Certificate verification is DISABLED for internal health checks. For production deployments, provide --ssl-ca-certs or use CA-signed certificates.
```

### ASGI-сервер

Значение прокидывается в `uvicorn.run(..., ssl_ca_certs=...)` во всех трех uvicorn-ветках и в `_run_granian_server(..., ssl_ca=ssl_ca_certs, ssl_client_verify=False)`. Про Granian все однозначно: mTLS выключен явным аргументом. Для uvicorn SGLang **не** пробрасывает параметр, отвечающий за требование клиентского сертификата, — в вызове присутствуют только `ssl_keyfile`, `ssl_certfile`, `ssl_ca_certs` и `ssl_keyfile_password`. Считать, что `--ssl-ca-certs` включает взаимную аутентификацию, нельзя; фактический режим определяется дефолтом установленного uvicorn и проверяется на своей сборке:

```bash
<env>/bin/python -c "import inspect, uvicorn; print(inspect.signature(uvicorn.Config.__init__))"
```

### Hot-reload

При `--enable-ssl-refresh` `SSLCertRefresher` заводит отдельную задачу-наблюдатель именно за CA-файлом (`_watch_ca`) и при изменении вызывает `ssl_context.load_verify_locations(ca_path)`.

## Значения и формат

- Путь к PEM-файлу с одним или несколькими сертификатами CA. Каталог не подходит: проверка `os.path.isfile`.
- Файл обязан существовать на момент разбора аргументов, иначе `ValueError: SSL CA certificates file not found: '<путь>'. Please check the --ssl-ca-certs path.`
- Без пары `--ssl-certfile`/`--ssl-keyfile` — `ValueError: --ssl-ca-certs has no effect without --ssl-certfile and --ssl-keyfile.` Это не предупреждение, а отказ стартовать.
- Содержимое не разбирается: пустой или битый PEM обнаружится только при создании контекста.

## Когда использовать

- Всегда, когда включен TLS с самоподписанным или частным CA: иначе внутренние проверки самого сервера идут без верификации, о чем движок честно предупреждает.
- Когда сертификат выписан публичным CA, аргумент не нужен — системного бандла достаточно, но учтите, что при заданном `--ssl-certfile` и незаданном `--ssl-ca-certs` `ssl_verify()` вернет `False`, а не `True`. То есть даже с публичным CA внутренние запросы пойдут без проверки. Если это важно, укажите системный бандл явно (`/etc/ssl/certs/ca-certificates.crt` на Debian/Ubuntu).
- Не используйте как способ включить mTLS: на Granian-пути он выключен явно, на uvicorn-пути SGLang не передает нужный параметр.

## Влияние на производительность и память

Не влияет: файл читается один раз при создании SSL-контекста и один раз на каждый внутренний HTTPS-запрос warmup'а. На VRAM, RAM и throughput влияния нет.

## Взаимодействие с другими аргументами

- `--ssl-certfile` / `--ssl-keyfile`: обязательное условие; без них аргумент отвергается.
- `--enable-ssl-refresh`: добавляет отслеживание CA-файла отдельной задачей.
- `--enable-http2`: значение уходит в Granian как `ssl_ca` при `ssl_client_verify=False`.
- `--skip-server-warmup`: отключает те самые внутренние HTTPS-запросы, ради которых `ssl_verify()` и вычисляется; с ним первая роль аргумента исчезает, остается только передача в ASGI-сервер.
- `--ssl-keyfile-password`: независимый спутник той же пары.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --ssl-ca-certs has no effect without --ssl-certfile and --ssl-keyfile.` **Причина:** задан только CA-бандл. **Лечение:** либо убрать аргумент, либо добавить пару cert+key.
- **Симптом:** `ValueError: SSL CA certificates file not found: '<путь>'.` **Проверка:** `test -f <путь>`.
- **Симптом:** в логе предупреждение об отключенной верификации, хотя сертификат от публичного CA. **Причина:** `ssl_verify()` без `--ssl-ca-certs` возвращает `False` при любом включенном TLS. **Лечение:** указать системный бандл явно.
- **Симптом:** warmup падает с ошибкой проверки сертификата, сервер убивает сам себя (`kill_process_tree`) с сообщением `Initialization failed. warmup error: ...`. **Причина:** CA-бандл не содержит выдавшего сертификат CA, либо имя в сертификате не совпадает с адресом из `ServerArgs.url()` (а он подставляет петлю вместо `0.0.0.0`). **Лечение:** добавить `127.0.0.1` в SAN сертификата либо задать корректный CA-бандл.

## В arriero

Аргумент имеет смысл только вместе с TLS, а TLS на управляемом инстансе несовместим с менеджером: адрес инстанса строится безусловно как `http://<host>:<port>` (`instanceBaseUrl` в `apps/api/src/instances/endpoint.ts`). Поэтому для kind `ktransformers` `--ssl-ca-certs` практически неприменим. Шифрование канала обеспечивайте перед менеджером, а не внутри инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/server.pem --ssl-keyfile /etc/ssl/sglang/server.key --ssl-ca-certs /etc/ssl/sglang/internal-ca.pem
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/server.pem --ssl-keyfile /etc/ssl/sglang/server.key --ssl-ca-certs /etc/ssl/certs/ca-certificates.crt
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/ssl_utils.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `apps/api/src/instances/endpoint.ts` (адресация управляемого инстанса)
