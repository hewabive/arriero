---
schema: 1
engine: vllm
primaryName: "--middleware"
title: "--middleware"
summary: Импортирует и подключает произвольное ASGI-middleware по пути импорта. Код исполняется в процессе фронтенда и оказывается снаружи аутентификации, поэтому это граница доверия, а не настройка.
group: Frontend
related:
  - --api-key
  - --allowed-origins
  - --enable-request-id-headers
  - --disable-fastapi-docs
---

# --middleware

## Кратко

`--middleware package.module.Name` импортирует объект по указанному пути и добавляет его в приложение: класс — через `app.add_middleware()`, корутинную функцию — через `@app.middleware('http')`. Это штатная точка расширения HTTP-слоя: свои проверки заголовков, лимиты, метрики, аудит.

Два свойства, о которых надо помнить. Первое: указанный модуль импортируется в процесс движка, то есть исполняет произвольный код с правами инстанса. Второе: пользовательские middleware добавляются **последними**, а в starlette позже добавленное оказывается снаружи — ваш код видит запрос до проверки `--api-key`.

## Оригинальная справка

```text
Additional ASGI middleware to apply to the app. We accept multiple
--middleware arguments. The value should be an import path. If a function
is provided, vLLM will add it to the server using
`@app.middleware('http')`. If a class is provided, vLLM will
add it to the server using `app.add_middleware()`.
```

## Паспорт аргумента

- Флаги: `--middleware`
- Группа argparse: `Frontend`
- Тип значения: список строк, накапливаемый повторением флага (`action="append"`, `type=str`, `nargs` удален)
- Допустимые значения: путь импорта вида `module.submodule.Object`; в пути обязана быть хотя бы одна точка (используется `rsplit(".", 1)`)
- Значение по умолчанию: `field(default_factory=lambda: [])`, а в argparse дополнительно принудительно `default=[]`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.middleware`
- Этап применения: HTTP-слой, конец `build_app()` — после CORS, аутентификации, `X-Request-Id` и служебных middleware

## Что меняет в движке

В конце `build_app()` для каждого значения выполняется:

```python
module_path, object_name = middleware.rsplit(".", 1)
imported = getattr(importlib.import_module(module_path), object_name)
```

Дальше разветвление: `inspect.isclass(imported)` — `app.add_middleware(imported)`; `inspect.iscoroutinefunction(imported)` — `app.middleware("http")(imported)`; иначе `ValueError: Invalid middleware {…}. Must be a function or a class.` и сервер не стартует.

Классу передается только `app` — параметров конфигурации через CLI нет, настройки придется брать из окружения или из собственного файла.

Порядок исполнения — следствие того, как starlette собирает стек: последнее добавленное middleware внешнее. vLLM добавляет в таком порядке: CORS → аутентификация → `X-Request-Id` → служебные → пользовательские. Значит, ваш обработчик получает запрос первым (до проверки ключа) и ответ последним. Это удобно для аудита и для закрытия незащищенных путей вроде `/tokenize`, но означает, что ошибка в нем ломает весь HTTP-слой.

## Значения и формат

- Несколько middleware — несколько флагов: `--middleware pkg.a.First --middleware pkg.b.second`.
- Модуль должен быть импортируемым из окружения инстанса (`PYTHONPATH`, установленный пакет).
- Функция обязана быть `async def` с сигнатурой `(request, call_next)`; обычная функция отвергается.
- В arriero аргумент со списком значений сериализуется в **одну** строку через запятую (`--middleware a.b,c.d`), а vLLM разберет ее как единственный путь импорта и упадет на импорте `a.b,c`. Практический вывод: через управляемый инстанс можно надежно задать только одно middleware.

## Когда использовать

- Когда нужен контроль, которого нет в vLLM: закрыть незащищенные пути, ограничить размер тела, добавить собственные метрики или аудит.
- Когда требуется корреляция с внешней системой трассировки, которую не покрывает `--enable-request-id-headers`.
- Не используйте для того, что уже решается на прокси arriero: маршрутизация, лимиты, кеш ответов и трассировка запросов реализованы там (`docs/API_PROXY_FOUNDATION.md`, `docs/API_PROXY_PIPELINES.md`, arriero). Дублировать это в процессе движка — лишний код на критическом пути.

## Влияние на производительность и память

Само по себе подключение бесплатно, но каждое middleware лежит на пути **каждого** запроса. Особенно осторожно с обработчиками, которые буферизуют тело ответа: для потоковой генерации это ломает потоковость и увеличивает задержку до первого токена. Расход RAM определяется импортируемым кодом.

## Взаимодействие с другими аргументами

- `--api-key`: пользовательские middleware находятся снаружи аутентификации и видят все запросы, включая те, что будут отклонены с 401.
- `--allowed-origins` и остальные CORS-аргументы: CORS-слой самый внутренний, поэтому ответы, сформированные вашим middleware, не получат заголовков `Access-Control-Allow-*`.
- `--enable-request-id-headers`: штатный способ получить `X-Request-Id` без своего кода.
- `--disable-fastapi-docs`: закрыть документацию проще флагом, чем middleware.

## Типовые проблемы и диагностика

- **Симптом:** `ModuleNotFoundError` при старте. **Причина:** модуль не установлен в окружении инстанса или путь указан с ошибкой. **Проверка:** `python -c "import module.submodule"` в том же окружении.
- **Симптом:** `ValueError: Invalid middleware ... Must be a function or a class.` **Причина:** объект по пути не класс и не корутинная функция. **Лечение:** оформить как `async def` или класс ASGI.
- **Симптом:** потоковые ответы перестали приходить по мере генерации. **Причина:** middleware буферизует тело. **Лечение:** не трогать `body_iterator`.
- **Симптом (arriero):** в аргументах инстанса указано несколько middleware, а движок падает на импорте пути с запятой. **Причина:** список сериализуется одной строкой через запятую. **Лечение:** оставить одно значение.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --middleware mycompany.vllm_middleware.AuditMiddleware
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --middleware mycompany.vllm_middleware.AuditMiddleware --middleware mycompany.vllm_middleware.body_size_limit
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/docs/usage/security.md`
- `docs/API_PROXY_FOUNDATION.md` (arriero)
- `docs/API_PROXY_PIPELINES.md` (arriero)
