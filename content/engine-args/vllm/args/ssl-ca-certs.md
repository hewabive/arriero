---
schema: 1
engine: vllm
primaryName: "--ssl-ca-certs"
title: "--ssl-ca-certs"
summary: Файл доверенных удостоверяющих центров для проверки клиентских сертификатов. Сам по себе ничего не включает — нужен вместе с --ssl-cert-reqs.
group: Frontend
related:
  - --ssl-cert-reqs
  - --ssl-certfile
  - --ssl-keyfile
  - --enable-ssl-refresh
---

# --ssl-ca-certs

## Кратко

`--ssl-ca-certs` задает набор CA, которым сервер доверяет **при проверке сертификата клиента**. Это серверная сторона mTLS, а не список доверия для исходящих соединений движка (загрузка моделей с Hugging Face этим аргументом не настраивается).

Один аргумент ничего не меняет: без `--ssl-cert-reqs 1|2` сервер не будет запрашивать клиентский сертификат.

## Оригинальная справка

```text
The CA certificates file.
```

## Паспорт аргумента

- Флаги: `--ssl-ca-certs`
- Группа argparse: `Frontend`
- Тип значения: str (путь), допускается `None`
- Допустимые значения: путь к PEM-файлу с одним или несколькими сертификатами CA
- Значение по умолчанию: `None`
- Эффективное значение: не переопределяется; уходит в `uvicorn.Config(ssl_ca_certs=...)`, где превращается в `load_verify_locations` у `SSLContext`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.ssl_ca_certs`
- Этап применения: HTTP-слой, `serve_http()` → `uvicorn.Config(...).load()`

## Что меняет в движке

Значение только пробрасывается: `serve_http(..., ssl_ca_certs=args.ssl_ca_certs, ...)`. Логика проверки клиентского сертификата принадлежит `SSLContext` и определяется режимом из `--ssl-cert-reqs`.

При `--enable-ssl-refresh` путь передается в `SSLCertRefresher` как отдельная задача наблюдения: изменение файла CA приводит к вызову `load_verify_locations` и строке `Reloading SSL CA certificates` в логе. Наблюдение за CA включается независимо от наблюдения за парой ключ+сертификат.

## Значения и формат

- PEM-файл; несколько CA — просто несколько блоков в одном файле.
- Не задан — проверка клиентских сертификатов невозможна, какое бы значение ни стояло в `--ssl-cert-reqs`.
- Файл читается при старте и при каждом срабатывании наблюдателя, если включено обновление.

## Когда использовать

- Только для mTLS: сервер должен принимать запросы исключительно от клиентов с сертификатом, выпущенным вашим CA.
- Не путайте с настройкой доверия для исходящих HTTPS-запросов движка (скачивание весов) — она задается переменными окружения окружения Python, а не этим аргументом.
- Для управляемых инстансов arriero mTLS избыточен: менеджер обращается к инстансу по `http://<host>:<port>` (`docs/API_PROXY_FOUNDATION.md`, arriero) и клиентский сертификат не предъявляет.

## Влияние на производительность и память

Не влияет на память. Проверка цепочки клиента добавляет небольшую работу на рукопожатие.

## Взаимодействие с другими аргументами

- `--ssl-cert-reqs`: без него файл CA бесполезен; `2` (`CERT_REQUIRED`) делает клиентский сертификат обязательным.
- `--ssl-certfile`, `--ssl-keyfile`: TLS должен быть включен, иначе `SSLContext` вообще не создается.
- `--enable-ssl-refresh`: включает наблюдение за файлом CA.

## Типовые проблемы и диагностика

- **Симптом:** клиенты без сертификата продолжают подключаться. **Причина:** `--ssl-cert-reqs` оставлен в значении по умолчанию (`0`, `CERT_NONE`). **Лечение:** задать `2`.
- **Симптом:** `ssl.SSLError: [SSL: TLSV1_ALERT_UNKNOWN_CA]` на стороне клиента. **Причина:** сертификат клиента выпущен не тем CA. **Лечение:** добавить нужный CA в файл.
- **Симптом:** после ротации CA новые клиенты не подключаются. **Причина:** контекст держит старый набор. **Лечение:** перезапуск инстанса либо `--enable-ssl-refresh` и строка `Reloading SSL CA certificates` в логе как подтверждение.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 0.0.0.0 --ssl-certfile /etc/ssl/vllm/fullchain.pem --ssl-keyfile /etc/ssl/vllm/privkey.pem --ssl-ca-certs /etc/ssl/vllm/clients-ca.pem --ssl-cert-reqs 2
```

```bash
vllm serve /models/Qwen3-4B --host 0.0.0.0 --ssl-certfile /etc/ssl/vllm/fullchain.pem --ssl-keyfile /etc/ssl/vllm/privkey.pem --ssl-ca-certs /etc/ssl/vllm/clients-ca.pem --ssl-cert-reqs 2 --enable-ssl-refresh
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/launcher.py`
- `vllm/vllm/entrypoints/serve/utils/ssl.py`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
