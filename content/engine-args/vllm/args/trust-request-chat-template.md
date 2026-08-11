---
schema: 1
engine: vllm
primaryName: "--trust-request-chat-template"
title: "--trust-request-chat-template"
summary: Разрешает клиенту прислать собственный Jinja-шаблон чата в теле запроса. Решение безопасности: включенный флаг отдает рендеринг промпта тому, кто обращается к API.
group: Frontend
related:
  - --chat-template
  - --default-chat-template-kwargs
  - --api-key
  - --allowed-local-media-path
  - --enable-tokenizer-info-endpoint
---

# --trust-request-chat-template

## Кратко

По умолчанию сервер отвергает запрос, в котором есть поле `chat_template` (или `chat_template_kwargs.chat_template`), с кодом 400. Флаг снимает этот запрет.

Речь не о «гибкости API»: Jinja-шаблон — это исполняемый код в процессе API-сервера, и он полностью определяет, что уйдет модели, включая системную часть промпта. Включать флаг на сервере, доступном кому-то кроме доверенных клиентов, нельзя.

## Оригинальная справка

```text
Whether to trust the chat template provided in the request. If False,
the server will always use the chat template specified by `--chat-template`
or the ones from tokenizer.
```

## Паспорт аргумента

- Флаги: `--trust-request-chat-template`, `--no-trust-request-chat-template`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`) или присутствует парный `--no-...` / отсутствует оба (`false`)
- Значение по умолчанию: `false` — «не задан» означает именно запрет, а не «решит движок»
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.trust_request_chat_template`
- Этап применения: HTTP-слой, проверка перед рендерингом каждого чат-запроса

## Что меняет в движке

Флаг разъезжается по всем компонентам, которые рендерят чат: `OnlineRenderer`, `OnlineDerenderer`, `ServingTokenization`, `OpenAIServingChat` и io-процессорам пулинга (`vllm/entrypoints/pooling/base/io_processor.py`).

Проверка одна и та же (`OnlineRenderer.validate_chat_template`):

```text
Chat template is passed with request, but --trust-request-chat-template is not set.
Refused request with untrusted chat template.
```

Она срабатывает, если в запросе непусто `chat_template` **или** непусто `chat_template_kwargs["chat_template"]` — второй путь закрыт специально, иначе шаблон можно было бы протащить через словарь kwargs. В пулинге та же проверка бросает `ValueError`.

Когда флаг включен, `ChatCompletionRequest.build_chat_params` формирует `chat_template = request.chat_template or default_template`, то есть запросный шаблон становится первым приоритетом в `resolve_chat_template` и полностью вытесняет и `--chat-template`, и шаблон токенизатора.

Есть один обход, который стоит знать: для моделей Harmony (`model_type == "gpt_oss"`) `render_chat` идет по ветке `_make_request_with_harmony` и проверку не вызывает — но там запросный шаблон и не применяется, промпт строится структурно.

## Значения и формат

- Флаг без значения: `--trust-request-chat-template` — включено.
- Явное выключение: `--no-trust-request-chat-template`.
- «Не задан» = `false`. Никакого «решит движок» здесь нет.
- Проверяются оба поля запроса: `chat_template` (строка) и `chat_template_kwargs.chat_template`. Прочие ключи `chat_template_kwargs` флагом не ограничены и принимаются всегда.

## Когда использовать

- Локальная разработка и подбор шаблона: удобнее гонять варианты через `POST /tokenize` с телом запроса, чем перезапускать сервер на каждую правку файла.
- Полностью доверенный внутренний клиент, которому нужен свой формат промпта и который вы контролируете так же, как саму конфигурацию сервера.
- Не включайте на инстансе, который обслуживает больше одного потребителя: шаблон из запроса перекрывает системную разметку, разметку инструментов и любые ограничения, заложенные в серверный шаблон.
- Не включайте «на всякий случай» вместе с `--api-key`: ключ ограничивает круг клиентов, но не понижает права того, кто ключ получил.

## Влияние на производительность и память

Прямого влияния на VRAM, KV-cache и время старта нет. Есть косвенный эффект на throughput: свой шаблон у каждого клиента означает разные префиксы промптов, поэтому prefix caching перестает попадать — при `--enable-prefix-caching` доля кэш-хитов падает, а prefill выполняется заново. Плюс каждый новый текст шаблона занимает место в кэшах разбора (`_detect_content_format` — `lru_cache(maxsize=32)`), и при большом разнообразии шаблонов Jinja-компиляция начинает выполняться в горячем пути.

## Взаимодействие с другими аргументами

- `--chat-template`: при включенном флаге запросный шаблон побеждает серверный; при выключенном серверный остается единственным способом переопределения.
- `--default-chat-template-kwargs`: серверные kwargs этой проверкой не ограничены и продолжают подмешиваться под запросные значения.
- `--api-key`: ограничивает, кто может обратиться; не ограничивает, что этот клиент может сделать с промптом.
- `--allowed-local-media-path`: другой аргумент того же класса риска — расширяет то, что клиент может заставить сервер прочитать.
- `--enable-tokenizer-info-endpoint`: отдает наружу серверный шаблон; вместе с этим флагом клиент видит эталон и может прислать его модификацию.

## Типовые проблемы и диагностика

- **Симптом:** 400 `Chat template is passed with request, but --trust-request-chat-template is not set. Refused request with untrusted chat template.` **Причина:** клиент шлет `chat_template` в теле. **Лечение:** убрать поле из запроса и перенести шаблон в `--chat-template`, либо (осознанно) включить флаг.
- **Симптом:** та же ошибка, а поля `chat_template` в запросе нет. **Причина:** шаблон лежит внутри `chat_template_kwargs.chat_template`. **Проверка:** тело запроса целиком. **Лечение:** убрать вложенный ключ.
- **Симптом:** после включения флага ответы стали хуже, хотя серверный шаблон не менялся. **Причина:** клиент присылает свой шаблон и он побеждает. **Проверка:** сравнить отрендеренный промпт через `POST /tokenize` с телом и без `chat_template`. **Лечение:** выключить флаг.
- **Симптом:** просела доля попаданий prefix cache. **Причина:** разные шаблоны от разных клиентов дают разные префиксы. **Проверка:** `gpu_prefix_cache_hit_rate` в `/metrics`. **Лечение:** зафиксировать шаблон на сервере.
- **Симптом (arriero):** через прокси приходят запросы от нескольких источников. **Причина:** один инстанс обслуживает нескольких потребителей, и «доверенный клиент» перестает быть одним. **Лечение:** оставить флаг выключенным; для отдельного потребителя завести отдельный инстанс.

## Примеры

```bash
vllm serve /models/Qwen3-4B --trust-request-chat-template --host 127.0.0.1 --port 8000
```

```bash
vllm serve /models/Qwen3-4B --no-trust-request-chat-template --chat-template /etc/vllm/qwen3-tools.jinja
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/renderers/online_renderer.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/tokenize/serving.py`
- `vllm/vllm/entrypoints/pooling/base/io_processor.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/docs/usage/security.md`
