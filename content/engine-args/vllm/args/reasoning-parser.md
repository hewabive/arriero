---
schema: 1
engine: vllm
primaryName: "--reasoning-parser"
title: "--reasoning-parser"
summary: Включает разбор блока рассуждений модели в отдельное поле ответа и одновременно учит structured outputs не применять грамматику внутри рассуждения. Имя берётся из runtime-реестра; неверный парсер тихо ломает форму ответа.
group: StructuredOutputsConfig
related:
  - --reasoning-parser-plugin
  - --structured-outputs-config
  - --reasoning-config
  - --tool-call-parser
  - --enable-auto-tool-choice
  - --chat-template
---

# --reasoning-parser

## Кратко

Reasoning-модели выдают рассуждение и ответ одним потоком токенов, разделённым служебными маркерами вроде `<think>` / `</think>`. Без `--reasoning-parser` весь этот текст, вместе с маркерами, попадает в `content` ответа. С парсером рассуждение уходит в отдельное поле (`reasoning`, оно же устаревшее `reasoning_content`), а в `content` остаётся только ответ.

Второй, менее очевидный эффект: тот же парсер используется внутри движка структурированным выводом — грамматика не применяется, пока модель находится в блоке рассуждения. То есть аргумент влияет не только на HTTP-слой.

## Оригинальная справка

```text
Select the reasoning parser depending on the model that you're using.
This is used to parse the reasoning content into OpenAI API format.
```

## Паспорт аргумента

- Флаги: `--reasoning-parser`
- Группа argparse: `StructuredOutputsConfig`
- Тип значения: строка — имя, зарегистрированное в реестре
- Допустимые значения: `choices` пуст намеренно — список собирается в runtime из `ReasoningParserManager` (`vllm/reasoning/abs_reasoning_parsers.py`), куда имена попадают из таблицы `_REASONING_PARSERS_TO_REGISTER` в `vllm/reasoning/__init__.py` и из плагинов, загруженных `--reasoning-parser-plugin`. Список установленной сборки: `python -c "from vllm.reasoning import ReasoningParserManager as M; print(M.list_registered())"` в окружении инстанса; он же печатается в тексте ошибки при неверном имени. Переписывать перечень сюда бессмысленно — он меняется каждый релиз
- Значение по умолчанию: `""` — разбора нет
- Эффективное значение: не переопределяется по модели. Дополнительно копируется в `ReasoningConfig.reasoning_parser` (`_set_default_reasoning_config_args`) и в `StructuredOutputsConfig.reasoning_parser`; при заданном `--structured-outputs-config.reasoning_parser` верхнеуровневый флаг перекрывает его
- Где объявлен: `vllm/config/structured_outputs.py:StructuredOutputsConfig.reasoning_parser`
- Этап применения: валидация аргументов API-сервера (до подъёма движка) → инициализация `StructuredOutputManager` в engine core → построение парсера в chat/responses/anthropic/cohere-сервингах

## Что меняет в движке

**HTTP-слой.** `ParserManager.get_parser()` (`vllm/parser/parser_manager.py`) достаёт класс парсера из реестра и композирует его с tool-парсером в один `Parser`, который получает каждый chat-completion и responses-запрос. Для нестримингового ответа вызывается `extract_reasoning(model_output, request)` и возвращает пару `(reasoning, content)`; для стриминга — `extract_reasoning_streaming(...)`, раздающий дельты либо в `reasoning`, либо в `content`.

Базовая реализация `BaseThinkingReasoningParser` (`vllm/reasoning/basic_parsers.py`) устроена так: стартовый маркер, если он есть, отрезается, затем текст делится по конечному маркеру. **Если конечного маркера в выводе нет, весь ответ считается рассуждением и возвращается `(model_output, None)`** — это и есть главный симптом неверно выбранного парсера.

**Engine core.** `StructuredOutputManager` (`vllm/v1/structured_output/__init__.py`) при непустом `reasoning_parser` создаёт свой экземпляр парсера и по умолчанию (`enable_in_reasoning=False`) не накладывает грамматику на токены до конца рассуждения — используются `is_reasoning_end()` и `is_reasoning_end_streaming()`. Без парсера структурированный вывод начинает принуждать грамматику с первого же токена, и reasoning-модель ломается на собственном `<think>`.

**Валидация.** `validate_api_server_args()` в `vllm/entrypoints/openai/api_server.py` проверяет имя по `ReasoningParserManager.list_registered()` уже после загрузки плагина и до старта движка. Имя вне реестра — `KeyError: invalid reasoning parser: X (chose from { ... })`, и в скобках печатается актуальный список.

## Значения и формат

- Пустая строка (значение по умолчанию) — разбора нет, поле `reasoning` в ответах всегда `null`.
- Имена регистрозависимы и пишутся так, как в реестре: `deepseek_r1`, `qwen3`, `glm47`, `granite`, `openai_gptoss`, `mistral`, `minimax_m2` и т. д. Один и тот же класс часто зарегистрирован под несколькими именами (например `glm45` и `glm47`), а одно имя может указывать на общий парсер для нескольких семейств.
- Регистрация ленивая: модуль парсера импортируется только при первом обращении, поэтому ошибка импорта конкретного парсера всплывает как исключение при валидации, а не при старте процесса.
- Имя файла в `vllm/reasoning/` не равно имени в реестре: `IdentityReasoningParser` из `identity_reasoning_parser.py` в таблицу регистрации не входит и по CLI недоступен, а `qwen3_engine_reasoning_parser` доступен сразу под двумя именами (`qwen3`, `mimo`). Проверяйте `list_registered()`, а не список файлов.

## Когда использовать

- **Reasoning-модель за arriero-прокси.** Клиент (в том числе Claude Code через Anthropic-мост) ожидает в `content` только ответ. Без парсера `content` содержит `<think>…</think>` целиком: это и мусор в выводе, и лишние токены в истории диалога.
- **Structured outputs на reasoning-модели.** Здесь парсер практически обязателен: иначе грамматика применяется к рассуждению.
- **Подсчёт токенов рассуждения.** `count_reasoning_tokens()` даёт отдельную статистику по блоку рассуждения в Responses API.
- **Не задавайте «на всякий случай».** Парсер для чужого семейства не «ничего не сделает» — он с высокой вероятностью отправит весь ответ в `reasoning` и оставит `content` пустым.
- **Не путайте с `--tool-call-parser`.** Это разные реестры и разные аргументы; composed-парсер собирается из обоих независимо.

## Влияние на производительность и память

На VRAM и на пропускную способность не влияет: разбор — это работа со строками и списками id токенов на стороне API-сервера и на управляющем пути structured outputs. Заметная стоимость появляется только в стриминге, где парсер вызывается на каждой дельте, но она несопоставима с шагом модели. Косвенный эффект в другую сторону: у моделей с длинным рассуждением корректно отделённый `reasoning` не попадает обратно в промпт следующего хода, и контекст (а с ним и KV-cache) растёт медленнее.

## Взаимодействие с другими аргументами

- `--reasoning-parser-plugin`: подгружает внешний файл с парсерами до валидации имени, поэтому имя из плагина здесь допустимо.
- `--structured-outputs-config`: содержит то же поле (`reasoning_parser`) плюс `enable_in_reasoning`. Верхнеуровневый флаг перекрывает значение из JSON. `enable_in_reasoning=true` отключает пропуск грамматики внутри рассуждения — то есть нейтрализует главный движковый эффект парсера.
- `--reasoning-config`: отдельный конфиг, в который имя парсера тоже копируется (`_set_default_reasoning_config_args`); задавать его вручную ради этого не нужно.
- `--tool-call-parser`, `--enable-auto-tool-choice`, `--tool-parser-plugin`: соседний, независимый механизм; оба парсера объединяются в один `Parser`. Для отдельных семейств (`kimi_k3`, harmony-модели) композиция особая и подставляется автоматически.
- `--chat-template`: шаблон решает, попадёт ли стартовый маркер `<think>` в промпт. Часть парсеров рассчитана на модели, которые стартовый маркер не генерируют, и трактует начало вывода как рассуждение по умолчанию — при нестандартном шаблоне это даёт неверную разметку.

## Типовые проблемы и диагностика

- **Симптом:** `content` пустой или `null`, весь ответ оказался в `reasoning`. **Причина:** парсер не нашёл конечный маркер — почти всегда взято имя от другого семейства моделей. **Проверка:** отправить запрос без парсера и посмотреть, какие маркеры модель реально печатает. **Лечение:** выбрать парсер, чьи маркеры совпадают.
- **Симптом:** `KeyError: invalid reasoning parser: qwen (chose from { deepseek_r1,deepseek_v3,... })`. **Причина:** имени нет в реестре. **Лечение:** взять имя из списка в самом сообщении.
- **Симптом:** `RuntimeError: <Parser> reasoning parser could not locate think start/end tokens in the tokenizer!` **Причина:** парсер требует, чтобы маркеры были отдельными токенами в словаре токенизатора, а у модели их нет. **Лечение:** другой парсер либо правильный токенизатор (`--tokenizer`).
- **Симптом:** `TypeError: reasoning_parser_name='X' has not been registered` из `ParserManager`. **Причина:** имя прошло валидацию сервера, но класс не импортируется (сломанный плагин или отсутствующая зависимость). **Проверка:** в логе рядом лежит `Failed to import lazy reasoning parser 'X' from <module>` с трейсбеком.
- **Симптом:** structured outputs на reasoning-модели выдают невалидный JSON или обрываются. **Причина:** парсер не задан, грамматика применяется с первого токена. **Лечение:** задать `--reasoning-parser`; при обратной потребности — `--structured-outputs-config '{"enable_in_reasoning": true}'`.
- **Симптом (arriero):** в UI лаборатории API ответ выглядит пустым, хотя токены израсходованы. **Причина:** та же — весь текст ушёл в `reasoning`, а панель показывает `content`. **Проверка:** сырой ответ в трассировке запроса.
- **Подтверждение принятого значения:** прямой проверки в логе нет — сервер лишь не падает на валидации. Подтверждение практическое: непустое поле `reasoning` в ответе `/v1/chat/completions`.

## Примеры

```bash
vllm serve /models/DeepSeek-R1-Distill-Qwen-7B --reasoning-parser deepseek_r1 --max-model-len 16384
```

```bash
vllm serve /models/Qwen3-4B --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser hermes
```

## Источники

- `vllm/vllm/config/structured_outputs.py`
- `vllm/vllm/reasoning/abs_reasoning_parsers.py`
- `vllm/vllm/reasoning/__init__.py`
- `vllm/vllm/reasoning/basic_parsers.py`
- `vllm/vllm/parser/parser_manager.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/v1/structured_output/__init__.py`
- `vllm/vllm/engine/arg_utils.py`
