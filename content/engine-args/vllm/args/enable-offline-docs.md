---
schema: 1
engine: vllm
primaryName: "--enable-offline-docs"
title: "--enable-offline-docs"
summary: Переводит Swagger UI на статику, поставляемую вместе с vLLM, вместо загрузки скриптов с CDN. Нужен только на хостах без выхода в интернет.
group: Frontend
related:
  - --disable-fastapi-docs
  - --root-path
  - --api-key
---

# --enable-offline-docs

## Кратко

Обычный Swagger UI в FastAPI тянет JS и CSS с внешнего CDN, поэтому на изолированном хосте страница `/docs` открывается пустой. Флаг заменяет ее собственным обработчиком, который ссылается на файлы, смонтированные по пути `/static` из каталога внутри пакета vLLM.

Это чисто вопрос удобства в закрытом контуре; на безопасность влияет только тем, что добавляет статический маршрут `/static`, доступный без аутентификации.

## Оригинальная справка

```text
Enable offline FastAPI documentation for air-gapped environments.
Uses vendored static assets bundled with vLLM.
```

## Паспорт аргумента

- Флаги: `--enable-offline-docs`, `--no-enable-offline-docs`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: игнорируется при заданном `--disable-fastapi-docs` (в `build_app()` это ветки `if/elif`); также бездействует, если каталога статики нет в установленном пакете
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.enable_offline_docs`
- Этап применения: HTTP-слой, `build_app()` — выбор конструктора `FastAPI` и подключение роутера офлайн-документации

## Что меняет в движке

Приложение создается как `FastAPI(docs_url=None, redoc_url=None, lifespan=lifespan)` — штатные Swagger UI и ReDoc выключены, но схема `openapi.json` остается.

Дальше `vllm/entrypoints/serve/instrumentator/offline_docs.py:attach_router` проверяет каталог `static` рядом с собой и, если он есть:

- монтирует его как `app.mount("/static", StaticFiles(directory=...), name="static")`;
- регистрирует собственный `/docs`, который отдает `get_swagger_ui_html(...)` со ссылками `/static/swagger-ui-bundle.js` и `/static/swagger-ui.css`;
- регистрирует служебный маршрут OAuth2-редиректа;
- пишет в лог `Offline documentation enabled with vendored static assets`.

Если каталога нет, в логе появляется `Static directory not found at %s. Offline docs will not be available.` и `/docs` остается отключенным. То есть флаг может оказаться бездействующим — это зависит от того, попала ли статика в конкретный wheel.

## Значения и формат

- Не задан — `false`, используется штатный Swagger UI с внешними ресурсами.
- `--enable-offline-docs` — включить.
- `--no-enable-offline-docs` — явно выключить.
- Ссылки на статику абсолютные (`/static/...`), поэтому при публикации через обратный прокси по подпути их надо проверять отдельно, даже если задан `--root-path`.

## Когда использовать

- На изолированном хосте, где Swagger UI действительно нужен и не открывается из-за отсутствия доступа к CDN.
- Не включайте на инстансах, доступных наружу: если документация не нужна, правильнее полностью отключить ее через `--disable-fastapi-docs`.
- Для управляемых инстансов arriero смысла нет: контракт для потребителей публикует прокси менеджера (`docs/API_PROXY_FOUNDATION.md`, arriero).

## Влияние на производительность и память

Отдача двух статических файлов по запросу страницы документации. На VRAM, старт и генерацию не влияет.

## Взаимодействие с другими аргументами

- `--disable-fastapi-docs`: имеет приоритет, при обоих флагах документации не будет.
- `--root-path`: не переписывает абсолютные ссылки на `/static`.
- `--api-key`: ни `/docs`, ни `/static` не входят в защищенные префиксы и остаются открытыми.

## Типовые проблемы и диагностика

- **Симптом:** `/docs` по-прежнему `404`, в логе `Static directory not found at ...`. **Причина:** в установленном пакете нет каталога статики. **Лечение:** проверить содержимое `vllm/entrypoints/serve/instrumentator/static` в окружении инстанса.
- **Симптом:** страница открывается, но без стилей и интерфейса. **Причина:** `/static` недоступен через обратный прокси. **Проверка:** `curl -I http://127.0.0.1:8000/static/swagger-ui.css`.
- **Симптом:** флаг задан, но в логе нет строки `Offline documentation enabled...`. **Причина:** одновременно включен `--disable-fastapi-docs`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --enable-offline-docs
```

```bash
curl -I http://127.0.0.1:8000/static/swagger-ui-bundle.js
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/instrumentator/offline_docs.py`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
