---
schema: 1
engine: vllm
primaryName: "--reasoning-config"
title: "--reasoning-config"
summary: JSON-объект `ReasoningConfig` — строки начала и принудительного конца блока рассуждений. Единственное, что он включает, — поддержку `thinking_token_budget` в запросах; без него это поле отвергается.
group: VllmConfig
related:
  - --reasoning-parser
  - --reasoning-parser-plugin
  - --structured-outputs-config
  - --max-model-len
  - --max-num-seqs
---

# --reasoning-config

## Кратко

`--reasoning-config` заполняет `ReasoningConfig` (`vllm/config/reasoning.py`) — три настраиваемых поля и механизм, который превращает их в идентификаторы токенов через токенизатор модели. Назначение ровно одно: включить ограничение длины размышлений на уровне сэмплера. Пока `vllm_config.reasoning_config` равен `None` или не смог инициализировать токены, запрос с `thinking_token_budget` отвергается ошибкой.

Отдельно задавать этот конфиг нужно редко: `--reasoning-parser` создает его автоматически, а строки начала и конца берутся из самого парсера.

## Оригинальная справка

```text
The configurations for reasoning model.
```

## Паспорт аргумента

- Флаги: `--reasoning-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--reasoning-config.<поле> <значение>`)
- Допустимые значения: поля `reasoning_parser`, `reasoning_start_str`, `reasoning_end_str`
- Значение по умолчанию: `None` — механизм бюджета размышлений выключен
- Эффективное значение: `EngineArgs._set_default_reasoning_config_args()` создает объект автоматически, если задан `--reasoning-parser`, и записывает в его поле `reasoning_parser` то же имя. Затем `VllmConfig.__post_init__` вызывает `initialize_token_ids(model_config)`, который догружает недостающие строки из парсера и токенизирует их; при неудаче конфиг остается «не включенным» (`enabled == False`) с предупреждением в логе
- Где объявлен: `vllm/config/vllm.py:VllmConfig.reasoning_config`
- Этап применения: `create_engine_config` → `VllmConfig.__post_init__` (токенизация строк) → инициализация сэмплера (`ThinkingBudgetState`) → валидация каждого запроса → сэмплинг на каждом шаге

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `reasoning_parser` | `""` | имя парсера из `ReasoningParserManager`; из него берутся строки начала/конца рассуждений, если они не заданы явно |
| `reasoning_start_str` | `""` | строка, открывающая блок рассуждений (например, тег начала thinking у конкретной модели) |
| `reasoning_end_str` | `""` | строка, которую движок **принудительно вставляет**, когда бюджет размышлений исчерпан. Может включать переходную фразу перед естественным маркером конца |

`initialize_token_ids()` работает так: если задан `reasoning_parser`, у него запрашиваются `reasoning_start_str` и `reasoning_end_str` и подставляются вместо пустых полей; естественный маркер конца запоминается отдельно (`natural_reasoning_end_token_ids`) — по нему сэмплер понимает, что модель завершила размышления сама. Затем все три строки токенизируются с `add_special_tokens=False`. Если после этого хотя бы одна из строк пуста или дает пустой список токенов, инициализация не выполняется.

Токены читает `ThinkingBudgetState` (`vllm/v1/sample/thinking_budget_state.py`): он отслеживает, находится ли запрос внутри блока рассуждений, считает выданные токены и по достижении `thinking_token_budget` принудительно выдает `reasoning_end_token_ids`. Отдельного флага «включить» нет — переключателем служит сам факт непустого `reasoning_config`.

## Значения и формат

- Обе формы: `--reasoning-config '{"reasoning_parser":"deepseek_r1"}'` и `--reasoning-config.reasoning_parser deepseek_r1`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- Значение валидируется на разборе CLI как датакласс; неизвестный ключ отвергается сразу. Ошибка токенизации возникает позже — при сборке `VllmConfig`, уже после загрузки токенизатора.
- Поля `_reasoning_start_token_ids`, `_reasoning_end_token_ids`, `_natural_reasoning_end_token_ids`, `_enabled` служебные (`init=False`) — задавать их нельзя.
- **Список имен парсеров собирается в runtime** из реестра `ReasoningParserManager` (`vllm/reasoning/`) и расширяется через `--reasoning-parser-plugin`, поэтому статического перечня нет. Актуальный список — `vllm serve --help=reasoning-parser` в нужном окружении.
- Строки задаются в тексте, а не в идентификаторах токенов; движок токенизирует их сам и требует, чтобы результат был непустым.

## Когда использовать

- **Ограничение длины размышлений.** Единственный сценарий, ради которого конфиг существует: разрешить клиентам `thinking_token_budget` и тем самым не давать reasoning-модели тратить весь контекст на внутренний монолог.
- **Нестандартные маркеры.** Если модель использует свои теги, а подходящего парсера нет, задайте `reasoning_start_str`/`reasoning_end_str` вручную.
- **Переходная фраза.** В `reasoning_end_str` можно положить не только маркер конца, но и фразу перед ним — тогда принудительное завершение выглядит естественнее.
- **Не задавайте его, если `--reasoning-parser` уже задан и вас устраивают маркеры парсера** — конфиг создастся сам.
- **Не путайте с парсингом ответа.** Разделение `reasoning_content` и `content` в OpenAI-формате делает `--reasoning-parser` на HTTP-слое; этот конфиг отвечает только за принудительное завершение размышлений.

## Влияние на производительность и память

- **VRAM.** `ThinkingBudgetState` держит небольшие тензоры состояния на устройстве, пропорциональные `--max-num-seqs` и числу спекулятивных токенов; на фоне KV-cache это шум.
- **Latency/throughput.** Дополнительная проверка на каждом шаге сэмплинга; измеримого влияния на пропускную способность нет.
- **Время старта.** Одна токенизация нескольких коротких строк.
- **Косвенный эффект.** Ограниченный бюджет размышлений сокращает длину ответов, а значит и занятость KV-cache — на reasoning-моделях это часто более действенный способ поднять concurrency, чем правка лимитов планировщика.

## Взаимодействие с другими аргументами

- `--reasoning-parser`: при заданном значении создает этот конфиг и перезаписывает его поле `reasoning_parser`. Задавать оба можно, но верхнеуровневый флаг выигрывает.
- `--reasoning-parser-plugin`: регистрирует внешний парсер, имя которого можно указать здесь.
- `--structured-outputs-config`: у него есть собственные поля `reasoning_parser`/`reasoning_parser_plugin`, заполняемые из тех же верхнеуровневых флагов; это независимый механизм — грамматики, а не бюджет.
- `--max-model-len`: бюджет размышлений имеет смысл в сопоставлении с длиной контекста.
- `--max-num-seqs`: задает размер буферов состояния бюджета.

## Типовые проблемы и диагностика

- **Симптом:** запрос с `thinking_token_budget` возвращает `thinking_token_budget is set but reasoning_config is not configured. Please set --reasoning-parser and/or --reasoning-config to use thinking_token_budget.` **Причина:** конфиг не создан или не инициализировался. **Лечение:** задать `--reasoning-parser` либо явные строки.
- **Симптом:** предупреждение при старте `Auto-initialization of reasoning token IDs failed. Please check whether your reasoning parser has implemented the 'reasoning_start_str' and 'reasoning_end_str'.` **Причина:** парсер не отдает нужные строки. **Лечение:** задать `reasoning_start_str` и `reasoning_end_str` вручную.
- **Симптом:** `ReasoningConfig: failed to tokenize reasoning strings: reasoning_start_str='...', reasoning_end_str='...'. Ensure the strings are valid tokens in the model's vocabulary.` **Причина:** строки не токенизируются (например, взяты от другой модели). **Лечение:** взять маркеры из чат-шаблона именно этой модели.
- **Симптом:** бюджет задан, но модель продолжает размышлять. **Причина:** `reasoning_start_str` не совпадает с фактическим тегом, поэтому сэмплер не считает, что запрос внутри блока. **Лечение:** сверить строки с чат-шаблоном модели.
- **Подтверждение принятого значения:** отсутствие предупреждения об инициализации при старте и успешный запрос с `thinking_token_budget`.
- **Симптом (arriero):** health показывает уведомление о неподдержанном `thinking_token_budget`. **Причина:** Model Runner V2 в закрепленном профиле не поддерживает это поле. **Лечение:** см. раздел про Model Runner V2 в `docs/VLLM_OPERATIONS.md` (документ arriero).

## Примеры

```bash
vllm serve /models/Qwen3-4B --reasoning-parser qwen3 --max-model-len 16384
```

```bash
vllm serve /models/Qwen3-4B --reasoning-config '{"reasoning_start_str":"<think>","reasoning_end_str":"\n</think>\n"}'
```

## Источники

- `vllm/vllm/config/reasoning.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/sample/thinking_budget_state.py`
- `vllm/vllm/v1/engine/input_processor.py`
- `vllm/docs/features/reasoning_outputs.md`
- `docs/VLLM_OPERATIONS.md` (arriero)
