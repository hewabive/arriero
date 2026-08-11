---
schema: 1
engine: vllm
primaryName: "--chat-template"
title: "--chat-template"
summary: Переопределяет Jinja-шаблон, которым сообщения чата превращаются в промпт. Нужен, когда у модели шаблона нет вовсе или встроенный шаблон не умеет tool-роли.
group: Frontend
related:
  - --chat-template-content-format
  - --default-chat-template-kwargs
  - --trust-request-chat-template
  - --tool-call-parser
  - --enable-auto-tool-choice
  - --tokenizer-mode
  - --enable-tokenizer-info-endpoint
  - --response-role
---

# --chat-template

## Кратко

`--chat-template` подменяет шаблон только на верхнем приоритете цепочки разрешения. Если аргумент не задан, шаблон ищется в processor'е, затем в токенизаторе, затем во встроенных fallback'ах vLLM — и если ничего не нашлось, каждый запрос к `/v1/chat/completions` падает с `ChatTemplateResolutionError`.

Значение читается **один раз** при инициализации состояния API-сервера. Правка файла шаблона на живом сервере ничего не меняет до перезапуска.

## Оригинальная справка

```text
The file path to the chat template, or the template in single-line form
for the specified model.
```

## Паспорт аргумента

- Флаги: `--chat-template`
- Группа argparse: `Frontend`
- Тип значения: str — путь к файлу, тело шаблона или имя встроенного файла шаблона
- Допустимые значения: не ограничены; форма определяется эвристикой (см. «Значения и формат»)
- Значение по умолчанию: `None` — шаблон берется из модели/токенизатора
- Эффективное значение: `load_chat_template(args.chat_template)` в `init_app_state` заменяет путь на **содержимое файла**; дальше по цепочке приоритетов работает `resolve_chat_template`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.chat_template`
- Этап применения: разбор CLI (валидация) → инициализация состояния API-сервера (чтение файла) → HTTP-слой, рендеринг каждого чат-запроса

## Что меняет в движке

Значение проходит три шага.

1. **Валидация при разборе CLI.** `validate_parsed_serve_args` вызывает `validate_chat_template` (`vllm/entrypoints/chat_utils.py`). Строка считается телом шаблона, если содержит хотя бы один из символов `{`, `}` или перевод строки. Иначе она обязана существовать как путь либо как файл в каталоге встроенных шаблонов `vllm/transformers_utils/chat_templates/`; если ни того, ни другого нет — процесс падает **до** загрузки весов.
2. **Чтение при старте сервера.** `init_app_state` (и параллельно `init_pooling_state`) вызывает `load_chat_template(args.chat_template)` — это `lru_cache` поверх `open(...).read()`. Полученная строка кладется в `OnlineRenderer.chat_template`, `ServingTokenization.chat_template`, все serving-классы и `ChatTemplateConfig` пулинга.
3. **Разрешение на каждый запрос.** `resolve_chat_template` (`vllm/renderers/hf.py`) выбирает шаблон по приоритетам:
   - заданный шаблон (серверный или пришедший в запросе);
   - шаблон `AutoProcessor` — **только если в запросе нет `tools`**;
   - шаблон `AutoTokenizer` (`chat_template` из `tokenizer_config.json`);
   - встроенный fallback по `model_type` из `vllm/transformers_utils/chat_templates/registry.py` (в реестре — узкий список мультимодальных типов вроде `blip-2`, `paligemma`, `minicpmv`).

   Если после всех четырех шагов шаблона нет, `safe_apply_chat_template` бросает `ChatTemplateResolutionError` с текстом «As of transformers v4.44, default chat template is no longer allowed...».

Второй пункт — источник неочевидного поведения: как только клиент прислал `tools`, шаблон процессора перестает участвовать, и мультимодальная модель может внезапно поехать на шаблоне токенизатора.

Для `--tokenizer-mode cohere` и `kimi_k3` рендеринг идет не через Jinja, а через собственный рендерер; там значение `--chat-template` передается дальше как `template_jinja` (`vllm/renderers/cohere.py`).

## Значения и формат

- **Путь к файлу**: `--chat-template /etc/vllm/qwen-tools.jinja`. Файл читается целиком при старте.
- **Тело шаблона одной строкой**: любая строка, содержащая `{`, `}` или `\n`, принимается как есть, без проверки существования файла.
- **Имя встроенного шаблона**: имя файла из `vllm/transformers_utils/chat_templates/` — например `template_chatml.jinja`, `template_basic.jinja`. Просто `template_chatml` (без расширения) не найдется.
- Пустая строка не является «не задано»: она не содержит Jinja-символов и не существует как путь, поэтому валидация ее отклонит.
- **Имя именованного шаблона токенизатора (`tool_use`) на этом commit'е не принимается.** `vllm/docs/features/tool_calling.md` до сих пор советует `--chat-template tool_use`, но `validate_chat_template` отвергает такую строку с сообщением «The supplied chat template string (tool_use) appears path-like, but doesn't exist!». Расхождение проверяется чтением `validate_chat_template` в `vllm/entrypoints/chat_utils.py` вашей сборки; обход — выгрузить нужный вариант шаблона из `tokenizer_config.json` в файл и передать путь.

## Когда использовать

- Модель без `chat_template` в `tokenizer_config.json`: без аргумента любой чат-запрос будет отвечать `ChatTemplateResolutionError`, при этом `/v1/completions` продолжит работать — отсюда типичный диагноз «сервер живой, чат сломан».
- Включаете `--enable-auto-tool-choice`, а штатный шаблон не рендерит сообщения роли `tool` и `assistant.tool_calls` — многошаговый диалог будет терять результаты вызовов. Возьмите готовый шаблон из `examples/tool_chat_template_*.jinja` в checkout'е движка.
- Нужно зафиксировать формат промпта независимо от обновлений весов: шаблон в файле рядом с конфигурацией инстанса воспроизводим, шаблон из репозитория модели — нет.
- Не используйте для точечной настройки поведения шаблона (`enable_thinking`, `cohere_format` и подобное): для этого есть `--default-chat-template-kwargs`, не требующий копии всего шаблона.

## Влияние на производительность и память

На VRAM и на KV-cache не влияет. Влияет на длину промпта: другой шаблон — другое число токенов на то же сообщение, а значит другой расход KV-cache на запрос и другой шанс попадания в prefix cache. Замена шаблона на живой конфигурации обесценивает уже накопленный prefix cache: префикс системного промпта меняется побайтово.

Чтение файла происходит один раз при старте и на время старта не влияет. Само применение шаблона — CPU-работа в процессе API-сервера на каждый запрос.

## Взаимодействие с другими аргументами

- `--chat-template-content-format`: при `auto` формат контента определяется разбором AST именно этого шаблона; смена шаблона может молча сменить определенный формат.
- `--default-chat-template-kwargs`: значения по умолчанию для переменных того же шаблона.
- `--trust-request-chat-template`: без него шаблон из запроса отклоняется, и `--chat-template` остается единственным способом переопределить шаблон.
- `--tool-call-parser`, `--enable-auto-tool-choice`: парсер разбирает то, что модель сгенерировала по шаблону. Несогласованная пара «шаблон без tool-разметки + парсер» дает пустой `tool_calls`.
- `--tokenizer-mode`: режимы `cohere`, `kimi_k3`, `mistral` рендерят промпт не Jinja-шаблоном; смысл аргумента там другой.
- `--enable-tokenizer-info-endpoint`: отдает содержимое этого шаблона наружу через `GET /tokenizer_info`.
- `--response-role`: определяет роль в ответе; на рендеринг промпта не влияет.

## Типовые проблемы и диагностика

- **Симптом:** сервер не стартует, `ValueError: The supplied chat template string (...) appears path-like, but doesn't exist! Tried: ... and ...`. **Причина:** значение без Jinja-символов не найдено ни как путь, ни как встроенный шаблон. **Лечение:** передать существующий путь или тело шаблона.
- **Симптом:** `/v1/completions` работает, `/v1/chat/completions` отвечает ошибкой про «default chat template is no longer allowed». **Причина:** у модели нет шаблона и нет fallback'а по `model_type`. **Лечение:** задать `--chat-template`.
- **Симптом:** правка файла шаблона не действует. **Причина:** файл прочитан один раз в `init_app_state`, результат закэширован в `load_chat_template`. **Лечение:** перезапустить инстанс.
- **Симптом:** мультимодальная модель работает без `tools` и ломает разметку изображений, как только клиент присылает `tools`. **Причина:** приоритет 2 (`AutoProcessor`) пропускается при непустом `tools`. **Проверка:** сравнить `chat_template` из `GET /tokenizer_info` (при `--enable-tokenizer-info-endpoint`) с шаблоном процессора. **Лечение:** задать `--chat-template` явно.
- **Подтверждение принятого значения:** при `--chat-template-content-format auto` в логе появляется `Detected the chat template content format to be '<...>'` — строка вычисляется по фактически разрешенному шаблону. Полный текст шаблона виден в `GET /tokenizer_info`.
- **Симптом (arriero):** после смены весов инстанса ответы поменяли формат. **Причина:** шаблон приезжает из репозитория модели. **Лечение:** зафиксировать шаблон файлом и указать `--chat-template` в аргументах инстанса.

## Примеры

```bash
vllm serve /models/Qwen3-4B --chat-template /etc/vllm/qwen3-tools.jinja --enable-auto-tool-choice --tool-call-parser hermes
```

```bash
vllm serve /models/Qwen3-4B --chat-template template_chatml.jinja --chat-template-content-format string
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/vllm/renderers/hf.py`
- `vllm/vllm/transformers_utils/chat_templates/registry.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/pooling/factories.py`
- `vllm/tests/entrypoints/openai/test_cli_args.py`
- `vllm/docs/features/tool_calling.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
