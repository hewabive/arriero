---
schema: 1
engine: sglang
primaryName: "--ssl-keyfile-password"
title: "--ssl-keyfile-password"
summary: Пароль для зашифрованного приватного ключа. Передается в командной строке открытым текстом, попадает в лог старта и в ответ /server_info — единственная причина его задавать в том, что ключ иначе не расшифровать.
group: serving
related:
  - --ssl-keyfile
  - --ssl-certfile
  - --ssl-ca-certs
  - --enable-ssl-refresh
  - --enable-http2
  - --api-key
---

# --ssl-keyfile-password

## Кратко

`--ssl-keyfile-password` расшифровывает приватный ключ из `--ssl-keyfile`. Без пары `--ssl-certfile`/`--ssl-keyfile` аргумент отвергается на старте с сообщением «has no effect».

Главное здесь не механика, а гигиена: значение — секрет, который передается аргументом командной строки. Он виден в `/proc/<pid>/cmdline` любому пользователю хоста, печатается в строку `server_args=` при старте (`entrypoints/engine.py`) и возвращается endpoint'ом `/server_info` без всякой редакции. Переменной окружения-альтернативы у этого аргумента нет.

## Оригинальная справка

```text
The password to decrypt the SSL keyfile.
```

## Паспорт аргумента

- Флаги: `--ssl-keyfile-password`
- Группа: `serving`
- Тип значения: str
- Допустимые значения: не ограничены
- Значение по умолчанию: `None` — ключ считается незашифрованным
- Эффективное значение: совпадает с заданным; переписывания нет
- Где объявлен: `ServerArgs.ssl_keyfile_password`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `_handle_ssl_validation` (проверка осмысленности) → HTTP-слой (`uvicorn.run(ssl_keyfile_password=...)` либо `Granian(ssl_key_password=...)`)

## Что меняет в движке

Ничего внутри движка. Значение проходит насквозь в ASGI-сервер и используется при разборе PEM-ключа:

- во всех трех uvicorn-ветках `_setup_and_run_http_server` как `ssl_keyfile_password`;
- в `_run_granian_server` как `ssl_key_password` при `--enable-http2`.

Единственная собственная логика SGLang — проверка в `_handle_ssl_validation`:

```python
if not self.ssl_certfile and not self.ssl_keyfile:
    if self.ssl_keyfile_password:
        raise ValueError(
            "--ssl-keyfile-password has no effect without --ssl-certfile and --ssl-keyfile."
        )
```

Обратите внимание: правильность пароля здесь **не** проверяется. Неверный пароль обнаружится в самом конце старта, при создании SSL-контекста, когда веса уже загружены.

При `--enable-ssl-refresh` пароль в перезагрузку не передается: `SSLCertRefresher._watch_cert_key` вызывает `ssl_context.load_cert_chain(cert_path, key_path)` без аргумента `password`. Практически это значит, что hot-reload зашифрованного ключа не работает — обновление файла приведет к записи `Failed to reload SSL cert/key — continuing with previous certificates.` в лог, и сервер продолжит со старой парой.

## Значения и формат

- Произвольная строка. Пустая строка равносильна незаданному значению во всех проверках.
- Спецсимволы шелла нужно экранировать самому; аргумент проходит через обычный разбор командной строки.
- Способа прочитать пароль из файла или переменной окружения средствами SGLang нет. Обходной путь — подстановка на стороне запускающего шелла: `--ssl-keyfile-password "$(cat /etc/ssl/sglang/keypass)"`, но это не убирает значение из `/proc/<pid>/cmdline`.

## Когда использовать

- Только если ключ действительно зашифрован и расшифровать его заранее нельзя по требованиям хранения.
- В остальных случаях предпочтительнее держать ключ незашифрованным с правами `0600` и владельцем — сервисным пользователем: секрет в правах файловой системы защищен строго лучше, чем секрет в `cmdline` и в теле HTTP-ответа.
- Не задавайте «на всякий случай»: без cert+key это ошибка старта, а не безобидный лишний аргумент.

## Влияние на производительность и память

Не влияет ни на что: пароль используется один раз при разборе ключа.

## Взаимодействие с другими аргументами

- `--ssl-keyfile`, `--ssl-certfile`: обязательное условие, иначе `ValueError`.
- `--enable-ssl-refresh`: перезагрузка не передает пароль, поэтому с зашифрованным ключом hot-reload неработоспособен.
- `--enable-http2`: пароль уходит в Granian как `ssl_key_password`.
- `--ssl-ca-certs`: независим.
- `--api-key` / `--admin-api-key`: находятся в том же дампе `/server_info` и той же строке лога, что и пароль. Открытый `/server_info` компрометирует все три значения сразу.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --ssl-keyfile-password has no effect without --ssl-certfile and --ssl-keyfile.` **Причина:** пароль задан без пары cert+key. **Лечение:** убрать либо дополнить.
- **Симптом:** старт доходит до конца и падает при создании SSL-контекста. **Причина:** неверный пароль или ключ на самом деле не зашифрован. **Проверка:** `openssl rsa -in <key> -noout -passin pass:<пароль>`.
- **Симптом:** ключ обновили на диске, `--enable-ssl-refresh` включен, но клиенты видят старый сертификат, а в логе `Failed to reload SSL cert/key`. **Причина:** зашифрованный ключ и `load_cert_chain` без пароля. **Лечение:** держать ключ для hot-reload незашифрованным либо перезапускать сервер при ротации.
- **Проверка утечки:** `tr '\0' ' ' < /proc/<pid>/cmdline` и `curl -s http://127.0.0.1:30000/server_info | grep ssl_keyfile_password`.

## В arriero

TLS на управляемом инстансе несовместим с менеджером (адрес строится как `http://`, `apps/api/src/instances/endpoint.ts`), поэтому аргумент в штатном профиле `ktransformers` не применяется.

Если он все же попадет в аргументы инстанса, помните, куда именно ляжет секрет: в `config/instances/<name>.json` (возможно, под управлением config-git, `docs/CONFIG_GIT.md`), в `runtime/logs/<instance>.raw.log` через строку `server_args=` и в снапшот запуска (`process_runs.launchSnapshot`). Ни один из этих слоев не редактирует значения — в отличие от `config/.secrets.json`, куда arriero кладет ключи эндпоинтов прокси и который git игнорирует.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/server.pem --ssl-keyfile /etc/ssl/sglang/server-encrypted.key --ssl-keyfile-password "$(cat /etc/ssl/sglang/keypass)"
```

```bash
openssl rsa -in /etc/ssl/sglang/server-encrypted.key -out /etc/ssl/sglang/server.key && chmod 600 /etc/ssl/sglang/server.key && python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 0.0.0.0 --port 30000 --ssl-certfile /etc/ssl/sglang/server.pem --ssl-keyfile /etc/ssl/sglang/server.key
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/ssl_utils.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- arriero: `docs/CONFIG_GIT.md`, `apps/api/src/instances/endpoint.ts`
