---
schema: 1
engine: sglang
primaryName: "--ssl-certfile"
title: "--ssl-certfile"
summary: Путь к PEM-сертификату сервера. Задается только в паре с --ssl-keyfile и переводит весь HTTP-слой на HTTPS, включая внутренние запросы движка к самому себе.
group: serving
related:
  - --ssl-keyfile
  - --ssl-ca-certs
  - --ssl-keyfile-password
  - --enable-ssl-refresh
  - --enable-http2
  - --host
  - --port
  - --api-key
  - --tokenizer-worker-num
---

# --ssl-certfile

## Кратко

`--ssl-certfile` — половина обязательной пары, включающей TLS у HTTP-слоя SGLang. Второй половиной является `--ssl-keyfile`; любая из них без другой отвергается в `__post_init__`, до загрузки весов.

Включение TLS меняет не только внешний протокол: `ServerArgs.url()` начинает строить `https://…`, поэтому по HTTPS пойдет и внутренний warmup-запрос сервера к самому себе. Если сертификат самоподписанный и `--ssl-ca-certs` не задан, проверка сертификата для этих внутренних запросов отключается и в лог пишется отдельное предупреждение.

## Оригинальная справка

```text
The file path to the SSL certificate file.
```

## Паспорт аргумента

- Флаги: `--ssl-certfile`
- Группа: `serving`
- Тип значения: str — путь к существующему файлу (PEM-сертификат или цепочка)
- Допустимые значения: `choices` нет; путь обязан указывать на файл, `os.path.isfile` проверяется на этапе `__post_init__`
- Значение по умолчанию: `None` — TLS выключен, сервер слушает обычный HTTP
- Эффективное значение: совпадает с заданным; переписывания нет. Влияет на производные: `ServerArgs.url()` выбирает схему `https`, `ServerArgs.ssl_verify()` возвращает `False` (с предупреждением) вместо `True`, если не задан `--ssl-ca-certs`
- Где объявлен: `ServerArgs.ssl_certfile`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `_handle_ssl_validation` (парная проверка и существование файла) → HTTP-слой (`uvicorn.run(ssl_certfile=...)` либо `Granian(ssl_cert=...)`)

## Что меняет в движке

На инференс не влияет. Значение расходится по трем путям.

1. **Слушатель.** `_setup_and_run_http_server` (`entrypoints/http_server.py`) передает `ssl_certfile` во все три uvicorn-ветки (обычную, ветку `--enable-ssl-refresh`, multi-worker) и как `ssl_cert=` в `_run_granian_server` при `--enable-http2`. Перед стартом печатается строка `SSL enabled: certfile=<путь>, keyfile=<путь>`.
2. **Схема внутренних URL.** `ServerArgs.url()` возвращает `https://…`, если `ssl_certfile` задан. По этому URL warmup-поток обращается к `/model_info` и затем к `/generate`; тот же URL используется как `engine_info_bootstrap_url`.
3. **Проверка сертификата внутренним клиентом.** `ServerArgs.ssl_verify()` возвращает путь `--ssl-ca-certs`, если он задан; иначе — `False`, один раз залогировав `SSL is enabled but --ssl-ca-certs was not provided. Certificate verification is DISABLED for internal health checks.` Это значение уходит в `verify=` библиотеки `requests`.

Ранняя валидация в `_handle_ssl_validation` устроена так, что все ошибки конфигурации TLS вылетают до загрузки модели:

```python
if self.ssl_keyfile and not self.ssl_certfile: raise ValueError(...)
if self.ssl_certfile and not self.ssl_keyfile: raise ValueError(...)
if self.ssl_certfile and not os.path.isfile(self.ssl_certfile): raise ValueError(...)
```

## Значения и формат

- Абсолютный или относительный путь к PEM-файлу. Относительный резолвится от рабочего каталога процесса — для управляемого запуска задавайте абсолютный.
- Файл должен существовать **на момент разбора аргументов**. Симлинк допустим, каталог — нет: проверка именно `os.path.isfile`.
- Цепочка (сертификат сервера + промежуточные) в одном PEM поддерживается — этим занимается TLS-библиотека, SGLang содержимое не разбирает.
- Формат не проверяется на этапе валидации: непригодный файл даст ошибку уже при создании SSL-контекста, то есть в конце старта.
- Пустая строка равносильна незаданному значению (ложное значение во всех проверках).

## Когда использовать

- Когда сервер обязан быть доступен по сети и терминировать TLS сам. Это единственный сценарий: `--ssl-certfile` не дает ничего серверу, слушающему петлю.
- Не включайте TLS на инстансе за обратным прокси, который уже терминирует TLS: два слоя шифрования на одном хосте — это только лишняя нагрузка и лишняя точка отказа при ротации сертификатов.
- Не включайте на управляемом инстансе arriero — менеджер не умеет ходить в него по HTTPS (см. ниже).

## Влияние на производительность и память

VRAM и RAM не затрагиваются. Стоимость — TLS-хендшейк на каждое новое соединение и шифрование потока; для потоковой генерации, где соединение живет долго, накладные расходы малы. Время старта прибавляется на доли секунды (загрузка сертификата в контекст).

## Взаимодействие с другими аргументами

- `--ssl-keyfile`: обязательная пара, взаимно требуемая.
- `--ssl-ca-certs`: без `--ssl-certfile` отвергается с `--ssl-ca-certs has no effect without --ssl-certfile and --ssl-keyfile`; с ним — используется как CA-бандл внутреннего клиента.
- `--ssl-keyfile-password`: то же требование парности; без TLS отвергается.
- `--enable-ssl-refresh`: требует именно `--ssl-certfile` и `--ssl-keyfile`, иначе `ValueError`.
- `--enable-http2`: сертификат уходит в Granian как `ssl_cert`; при этом `--enable-ssl-refresh` с HTTP/2 запрещен.
- `--tokenizer-worker-num > 1`: TLS работает (аргументы уходят в multi-worker `uvicorn.run`), а вот hot-reload — нет, о чем пишется предупреждение.
- `--api-key`: без TLS ключ уходит по сети открытым текстом; связка `--host <внешний>` + `--api-key` без сертификата — плохая конфигурация.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --ssl-certfile requires --ssl-keyfile to be specified as well.` **Причина:** задана только одна половина пары. **Лечение:** задать обе.
- **Симптом:** `ValueError: SSL certificate file not found: '<путь>'. Please check the --ssl-certfile path.` **Причина:** пути нет или это каталог. **Проверка:** `test -f <путь> && echo ok`.
- **Симптом:** в логе `SSL is enabled but --ssl-ca-certs was not provided. Certificate verification is DISABLED for internal health checks.` **Причина:** самоподписанный сертификат без CA-бандла. **Последствие:** внутренние проверки идут без верификации; на внешних клиентов это не влияет. **Лечение:** задать `--ssl-ca-certs` либо принять как осознанный компромисс для стенда.
- **Симптом:** клиенты получают ошибку проверки имени хоста. **Причина:** сертификат выписан не на тот CN/SAN, по которому к серверу обращаются. SGLang содержимое сертификата не проверяет и такой ошибки не диагностирует. **Проверка:** `openssl x509 -in <cert> -noout -text | grep -A1 "Subject Alternative Name"`.
- **Симптом:** старт доходит до конца, а потом падает при создании SSL-контекста. **Причина:** файл существует, но не является валидным PEM или не соответствует ключу. **Проверка:** `openssl x509 -in <cert> -noout` и `openssl rsa -in <key> -noout -modulus`.

## В arriero

TLS на управляемом инстансе несовместим с менеджером. Адрес инстанса строится функцией `instanceBaseUrl` (`apps/api/src/instances/endpoint.ts`) как безусловный `http://<host>:<port>`, схемы `https` в этом коде нет вообще. Следствия:

- health-проба `/health` и проба `/v1/models` уйдут по HTTP на HTTPS-слушатель и завершатся ошибкой соединения, инстанс никогда не станет `ready`;
- сгенерированная запись каталога эндпоинтов для управляемого инстанса получит тот же `http://`-адрес, поэтому проксирование через `/v1/*` тоже не заработает.

Если инстанс должен быть виден по TLS снаружи, терминируйте TLS перед менеджером (обратный прокси перед arriero, `docs/SUBPATH_DEPLOY.md`), а сам SGLang оставляйте на `--host 127.0.0.1` без сертификата.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey.pem
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/fullchain.pem --ssl-keyfile /etc/ssl/sglang/privkey.pem --ssl-ca-certs /etc/ssl/sglang/ca.pem --api-key 3f2a9c7e1b4d8065
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/ssl_utils.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `apps/api/src/instances/endpoint.ts` (поведение адресации управляемого инстанса), `docs/API_PROXY_FOUNDATION.md`
