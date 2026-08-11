---
schema: 1
engine: vllm
primaryName: "--structured-outputs-config"
title: "--structured-outputs-config"
summary: JSON-объект `StructuredOutputsConfig` — движок грамматик для JSON Schema/regex/choice (`xgrammar`, `guidance`, `outlines`, `lm-format-enforcer` или `auto`), парсер рассуждений и два переключателя формата JSON. Backend выбирается один на весь сервер, per-request его сменить нельзя.
group: VllmConfig
related:
  - --reasoning-parser
  - --reasoning-parser-plugin
  - --reasoning-config
  - --tool-call-parser
  - --tokenizer-mode
  - --skip-tokenizer-init
  - --max-num-seqs
---

# --structured-outputs-config

## Кратко

`--structured-outputs-config` заполняет `StructuredOutputsConfig` (`vllm/config/structured_outputs.py`) — маленький конфиг из шести полей, определяющий, чем vLLM ограничивает генерацию, когда запрос содержит `response_format`, `guided_json`, `guided_regex` или `guided_choice`.

Главная эксплуатационная особенность: **backend выбирается один раз на процесс**. Запрос не может попросить другой движок грамматик; попытка приводит к ошибке валидации. При `backend: "auto"` (значение по умолчанию) выбор делается по содержимому первого подходящего запроса и затем фиксируется в параметрах.

## Оригинальная справка

```text
Structured outputs configuration.
```

## Паспорт аргумента

- Флаги: `--structured-outputs-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--structured-outputs-config.<поле> <значение>`)
- Допустимые значения: поля `StructuredOutputsConfig`; `backend` ограничен списком `auto`, `xgrammar`, `guidance`, `outlines`, `lm-format-enforcer`
- Значение по умолчанию: `Field(default_factory=StructuredOutputsConfig)` — объект со значениями по умолчанию, а не `None`
- Эффективное значение: `EngineArgs.create_engine_config` перезаписывает `reasoning_parser` значением `--reasoning-parser` и `reasoning_parser_plugin` значением `--reasoning-parser-plugin`, если те заданы, — без проверки на конфликт. Поле `backend` при значении `auto` доопределяется в runtime на первом структурированном запросе (`SamplingParams._validate_structured_outputs`) и запоминается
- Где объявлен: `vllm/config/vllm.py:VllmConfig.structured_outputs_config`
- Этап применения: разбор CLI → `create_engine_config` → инициализация `StructuredOutputManager` → валидация каждого запроса → построение грамматики → маскирование логитов на каждом шаге

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `backend` | `"auto"` | движок грамматик. `xgrammar` — быстрая компиляция, но поддерживает не весь JSON Schema; `guidance` (llguidance) — шире по возможностям; `outlines`; `lm-format-enforcer`. `auto` означает «выбери по содержимому запроса» |
| `disable_any_whitespace` | `false` | запрещает модели вставлять пробелы между полями JSON — вывод получается компактным. Поддерживается только `xgrammar` и `guidance` |
| `disable_additional_properties` | `false` | заставляет `guidance` игнорировать `additionalProperties` в схеме, приводя его поведение к `outlines`/`xgrammar`. Поддерживается только `guidance` |
| `reasoning_parser` | `""` | имя парсера рассуждений; структурированный вывод начинает применяться только **после** блока рассуждений |
| `reasoning_parser_plugin` | `""` | путь к внешнему модулю, регистрирующему парсер рассуждений; импортируется при инициализации менеджера |
| `enable_in_reasoning` | `false` | применять грамматику и внутри блока рассуждений |

Логика `auto` (в `SamplingParams._validate_structured_outputs`): сначала запрос проверяется на совместимость с `xgrammar`; при неудаче — переход на `guidance`, а если токенизатор Mistral не-tekken или схема содержит неподдерживаемые `guidance` конструкции — на `outlines`. Выбранное значение записывается в параметры запроса и в дальнейшем сравнивается с конфигурацией сервера.

Компиляция грамматик выполняется в пуле потоков размером `(cpu_count + 1) // 2` — это нагрузка на CPU хоста, а не на GPU.

## Значения и формат

- Обе формы: `--structured-outputs-config '{"backend":"guidance","disable_any_whitespace":true}'` и `--structured-outputs-config.backend guidance`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- Значение валидируется на разборе CLI: несуществующий backend или несовместимая комбинация полей (`disable_any_whitespace` не с `xgrammar`/`guidance`, `disable_additional_properties` не с `guidance`) отвергаются сразу.
- Пустая строка в `reasoning_parser` означает «парсер не задан», а не «выбери сам».
- **Список парсеров рассуждений собирается в runtime** из реестра `ReasoningParserManager` (`vllm/reasoning/`) и может расширяться плагинами, поэтому статического перечня допустимых значений нет. Смотрите фактический список через `vllm serve --help=reasoning-parser` в нужном окружении.

## Когда использовать

- **Зафиксировать backend в эксплуатации.** `auto` удобен, но его решение зависит от первого запроса и от версии библиотек — воспроизводимость страдает. Если клиенты шлют однотипные схемы, задайте backend явно.
- **`disable_any_whitespace: true`**, когда важен размер ответа и стабильность парсинга на стороне клиента.
- **`guidance`**, когда `xgrammar` отвергает вашу схему (рекурсия, сложные комбинации `anyOf`/`$ref`).
- **Не включайте `enable_in_reasoning` для reasoning-моделей по умолчанию** — грамматика внутри блока рассуждений ломает естественный формат размышлений и обычно ухудшает качество ответа.
- **Не задавайте `reasoning_parser` здесь, если уже используете `--reasoning-parser`** — верхнеуровневый флаг молча перетирает поле.

## Влияние на производительность и память

- **VRAM.** Прямого влияния нет: грамматики и битовые маски живут в хостовой памяти, маска применяется к логитам уже на устройстве.
- **RAM хоста и CPU.** Компиляция грамматики — это ощутимая CPU-нагрузка при первом появлении новой схемы; пул потоков ограничен половиной ядер. При большом разнообразии схем это заметная статья расхода на хосте.
- **Latency.** Первый запрос с новой схемой платит за компиляцию; последующие переиспользуют скомпилированную грамматику. Маскирование логитов добавляет фиксированную стоимость на шаг.
- **Время старта.** Не влияет: менеджер инициализируется лениво, а токенизатор все равно загружается.

## Взаимодействие с другими аргументами

- `--reasoning-parser`, `--reasoning-parser-plugin`: верхнеуровневые флаги тех же полей; при заданном значении они **перетирают** содержимое JSON без ошибки.
- `--reasoning-config`: другой, независимый конфиг — он отвечает за бюджет размышлений (`thinking_token_budget`), а не за грамматики, но `--reasoning-parser` заполняет оба.
- `--tool-call-parser`: соседний парсер HTTP-слоя, к грамматикам отношения не имеет.
- `--skip-tokenizer-init`: структурированный вывод без токенизатора невозможен — запрос отвергается с явным сообщением.
- `--tokenizer-mode`: для токенизаторов Mistral часть backend'ов исключается автоматически.
- `--max-num-seqs`: чем больше параллельных запросов со структурированным выводом, тем выше CPU-нагрузка на компиляцию и применение масок.

## Типовые проблемы и диагностика

- **Симптом:** argparse отвергает конфигурацию с `disable_any_whitespace is only supported for xgrammar and guidance backends.` **Лечение:** сменить backend или убрать поле.
- **Симптом:** `disable_additional_properties is only supported for the guidance backend.` **Лечение:** то же.
- **Симптом:** запрос падает с `Request-level structured output backend selection is not supported. The request specified 'X', but vLLM was initialised with 'Y'.` **Причина:** клиент переиспользует объект параметров, в котором остался backend от предыдущего вызова. **Лечение:** убрать `_backend` из запроса.
- **Симптом:** `Structured outputs requires a tokenizer so it can't be used with 'skip_tokenizer_init'`. **Лечение:** убрать `--skip-tokenizer-init`.
- **Симптом:** `Mistral tokenizer is not supported for the 'lm-format-enforcer' structured output backend.` **Лечение:** взять `xgrammar`/`outlines` или `--tokenizer-mode hf`.
- **Симптом:** `Structured outputs are not yet supported for diffusion language models.` **Причина:** dLLM-модель. **Лечение:** убрать ограничение из запроса.
- **Симптом:** первый запрос с новой схемой отвечает заметно дольше. **Причина:** компиляция грамматики. **Лечение:** ожидаемое поведение; при большом разнообразии схем стоит сократить их число на стороне клиента.
- **Подтверждение принятого значения:** сводка конфигурации движка при старте содержит `StructuredOutputsConfig(backend=...)`; ошибки выбора backend'а видны в ответах API, а не в логе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --structured-outputs-config '{"backend":"guidance","disable_any_whitespace":true}'
```

```bash
vllm serve /models/Qwen3-4B --structured-outputs-config.backend xgrammar --structured-outputs-config.enable_in_reasoning false
```

## Источники

- `vllm/vllm/config/structured_outputs.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/sampling_params.py`
- `vllm/vllm/v1/structured_output/__init__.py`
- `vllm/docs/features/structured_outputs.md`
