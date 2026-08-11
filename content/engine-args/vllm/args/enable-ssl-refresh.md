---
schema: 1
engine: vllm
primaryName: "--enable-ssl-refresh"
title: "--enable-ssl-refresh"
summary: Включает наблюдение за файлами сертификата, ключа и CA и перезагрузку SSL-контекста при их изменении, чтобы ротация сертификата не требовала перезапуска инстанса.
group: Frontend
related:
  - --ssl-certfile
  - --ssl-keyfile
  - --ssl-ca-certs
  - --ssl-cert-reqs
---

# --enable-ssl-refresh

## Кратко

Флаг создает `SSLCertRefresher` — фоновые задачи на `watchfiles.awatch`, которые следят за путями из `--ssl-keyfile`, `--ssl-certfile` и `--ssl-ca-certs`. При изменении файлов контекст обновляется на месте: `load_cert_chain` для пары ключ+сертификат и `load_verify_locations` для CA.

Это нужно ровно для одного сценария — автоматическая ротация сертификата (ACME/certbot и подобные) без перезапуска инстанса, то есть без повторной загрузки весов и прогрева.

## Оригинальная справка

```text
Refresh SSL Context when SSL certificate files change
```

## Паспорт аргумента

- Флаги: `--enable-ssl-refresh`, `--no-enable-ssl-refresh`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но фактически бездействует, если не заданы пути к файлам: наблюдение за цепочкой создается только при обоих `key_path` и `cert_path`, за CA — только при `ca_path`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.enable_ssl_refresh`
- Этап применения: HTTP-слой, `serve_http()` — после создания `uvicorn.Config`

## Что меняет в движке

`serve_http()` при включенном флаге создает `SSLCertRefresher(ssl_context=config.ssl, key_path=..., cert_path=..., ca_path=...)`:

1. Для пары ключ+сертификат заводится задача `awatch(key_path, cert_path)`; на каждое событие вызывается `load_cert_chain(cert_path, key_path)` и пишется `Reloading SSL certificate chain`.
2. Для CA заводится отдельная задача; на событие вызывается `load_verify_locations(ca_path)` и пишется `Reloading SSL CA certificates`.
3. При старте наблюдения в лог уходит `SSLCertRefresher monitors files: [...]` — это подтверждение, что механизм действительно включился.
4. Исключение внутри обработчика не роняет сервер: оно логируется как `SSLCertRefresher failed taking action on file change. Error: ...`, наблюдение продолжается со старым контекстом.
5. При завершении работы `stop()` снимает обе задачи.

Обновленный контекст действует на **новые** рукопожатия. Уже установленные соединения продолжают работать со старым сертификатом — для долгих SSE-потоков это ожидаемое поведение.

`watchfiles` — обязательная зависимость vLLM, отдельно ставить ее не нужно (в `requirements/common.txt` она помечена именно как «required for http server to monitor the updates of TLS files»).

## Значения и формат

- Не задан — `false`, файлы читаются один раз при старте.
- `--enable-ssl-refresh` — включить.
- `--no-enable-ssl-refresh` — явно выключить, в том числе чтобы перебить значение из YAML в `--config`.
- Флаг без `--ssl-certfile`/`--ssl-keyfile` безвреден и бесполезен: наблюдать не за чем.

## Когда использовать

- Когда сертификат обновляется автоматикой, а перезапуск инстанса стоит минуты загрузки модели и потери KV-cache.
- Не нужен, если сертификат долгоживущий и ротация все равно совпадает с окном обслуживания.
- Для управляемых инстансов arriero не применяется вместе с остальной группой `--ssl-*`: менеджер работает с инстансом по `http://<host>:<port>` (`docs/API_PROXY_FOUNDATION.md`, arriero).

## Влияние на производительность и память

Две фоновые задачи наблюдения за файлами; расход ресурсов на фоне инференса нулевой. На VRAM и время старта не влияет. Главный выигрыш — отсутствие перезапуска, то есть отсутствие повторной загрузки весов, компиляции и прогрева.

## Взаимодействие с другими аргументами

- `--ssl-certfile`, `--ssl-keyfile`: обязательное условие для наблюдения за цепочкой.
- `--ssl-ca-certs`: включает вторую, независимую задачу наблюдения.
- `--ssl-cert-reqs`: режим проверки клиента не меняется при перезагрузке файлов.

## Типовые проблемы и диагностика

- **Симптом:** сертификат обновлен, клиенты видят старый. **Причина:** событие не пришло (сертификат подменен через симлинк на другой каталог) либо соединение установлено до обновления. **Проверка:** наличие строки `Reloading SSL certificate chain` в логе. **Лечение:** обновлять сами файлы по наблюдаемым путям.
- **Симптом:** в логе `SSLCertRefresher failed taking action on file change. Error: ...`. **Причина:** файл в момент чтения был неполон или несогласован с ключом. **Лечение:** записывать новые файлы атомарно (запись во временный файл и `rename`).
- **Симптом:** строки `SSLCertRefresher monitors files:` нет. **Причина:** не заданы пути к сертификату и ключу, наблюдение не создано.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 0.0.0.0 --ssl-certfile /etc/ssl/vllm/fullchain.pem --ssl-keyfile /etc/ssl/vllm/privkey.pem --enable-ssl-refresh
```

```bash
vllm serve /models/Qwen3-4B --host 0.0.0.0 --ssl-certfile /etc/ssl/vllm/fullchain.pem --ssl-keyfile /etc/ssl/vllm/privkey.pem --ssl-ca-certs /etc/ssl/vllm/clients-ca.pem --ssl-cert-reqs 2 --enable-ssl-refresh
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/launcher.py`
- `vllm/vllm/entrypoints/serve/utils/ssl.py`
- `vllm/requirements/common.txt`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
