---
schema: 1
engine: vllm
primaryName: "--disable-fastapi-docs"
title: "--disable-fastapi-docs"
summary: Выключает схему OpenAPI, Swagger UI и ReDoc. Дешевый способ убрать с сервера полное описание доступных endpoint'ов, которое отдается без аутентификации.
group: Frontend
related:
  - --enable-offline-docs
  - --api-key
  - --root-path
  - --host
---

# --disable-fastapi-docs

## Кратко

Флаг меняет конструктор приложения: `FastAPI(openapi_url=None, docs_url=None, redoc_url=None, lifespan=lifespan)`. После этого `/docs`, `/redoc` и `/openapi.json` отвечают `404`.

Практический смысл — сокращение поверхности: пути документации лежат вне защищенных префиксов, поэтому при включенном `--api-key` они все равно доступны любому, кто дотянулся до порта, и выдают полный перечень endpoint'ов и схем запросов.

## Оригинальная справка

```text
Disable FastAPI's OpenAPI schema, Swagger UI, and ReDoc endpoint.
```

## Паспорт аргумента

- Флаги: `--disable-fastapi-docs`, `--no-disable-fastapi-docs`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false` — документация включена
- Эффективное значение: не переопределяется, но имеет приоритет над `--enable-offline-docs`: в `build_app()` это ветки `if/elif`, и при обоих флагах побеждает отключение
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.disable_fastapi_docs`
- Этап применения: HTTP-слой, самое начало `build_app()` — выбор конструктора `FastAPI`

## Что меняет в движке

Три URL перестают существовать: сама схема (`openapi_url`), Swagger UI (`docs_url`) и ReDoc (`redoc_url`). На маршруты API это не влияет — `/v1/chat/completions` и остальные работают как раньше.

Побочный эффект: пропадает удобный способ увидеть, какие endpoint'ы реально зарегистрированы в этой сборке. Замена — стартовый лог: `serve_http()` печатает `Available routes are:` и дальше по строке `Route: <path>, Methods: <...>` на каждый маршрут.

## Значения и формат

- Не задан — `false`, документация доступна.
- `--disable-fastapi-docs` — выключить.
- `--no-disable-fastapi-docs` — явно включить обратно, в том числе чтобы перебить значение из YAML в `--config`.

## Когда использовать

- На любом инстансе, доступном не только с петли: перечень маршрутов и схемы — это разведданные, отдаваемые бесплатно.
- На управляемых инстансах arriero: публичный контракт держит прокси менеджера, документация самого движка потребителям не нужна (`docs/API_PROXY_FOUNDATION.md`, arriero).
- Не выключайте на машине разработчика, где Swagger UI реально используется для проверки запросов.

## Влияние на производительность и память

Экономия символическая: не строится схема OpenAPI при первом обращении к `/openapi.json`. На VRAM, время старта и генерацию не влияет.

## Взаимодействие с другими аргументами

- `--enable-offline-docs`: взаимоисключающие по смыслу; при обоих заданных побеждает отключение.
- `--api-key`: не защищает пути документации, поэтому флаг закрывает то, чего ключ не закрывает.
- `--root-path`: имеет смысл в основном ради корректных ссылок в Swagger; вместе с отключенной документацией теряет большую часть смысла.
- `--enable-tokenizer-info-endpoint`: еще один незащищенный источник сведений о сервере, отключается отдельно.

## Типовые проблемы и диагностика

- **Симптом:** `/docs` отвечает `404` после обновления конфигурации. **Причина:** флаг включен. **Лечение:** `--no-disable-fastapi-docs`, если документация нужна.
- **Симптом:** нужно узнать список маршрутов при отключенной документации. **Лечение:** посмотреть блок `Available routes are:` в начале лога инстанса.
- **Симптом:** флаг `--enable-offline-docs` не дает эффекта. **Причина:** одновременно задан `--disable-fastapi-docs`, ветка `elif` не выполняется.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --disable-fastapi-docs
```

```bash
vllm serve /models/Qwen3-4B --host 0.0.0.0 --disable-fastapi-docs --api-key edge-key
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/launcher.py`
- `vllm/docs/usage/security.md`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
