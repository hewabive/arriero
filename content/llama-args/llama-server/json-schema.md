---
schema: 1
primaryName: "--json-schema"
title: "--json-schema"
summary: "Принимает inline JSON Schema, парсит ее на старте и конвертирует в grammar для constrained JSON generation. Для external `$ref` текущая справка llama.cpp рекомендует заранее конвертировать schema в grammar."
category: "Параметры сэмплинга"
valueType: "string"
estimation: "normal"
valueHint: "SCHEMA"
aliases:
  - "-j"
  - "--json-schema"
allowedValues: []
env: []
related:
  - "--json-schema-file"
  - "--grammar"
  - "--grammar-file"
  - "--backend-sampling"
  - "--logit-bias"
---

# --json-schema

## Кратко

`--json-schema` задает JSON Schema как строку CLI-аргумента. llama.cpp парсит JSON, конвертирует schema в grammar и использует grammar-based constrained generation.

Минимальный пример `{}` означает любой JSON object по help llama.cpp.

## Оригинальная справка llama.cpp

```text
JSON schema to constrain generations (https://json-schema.org/), e.g. `{}` for any JSON object
For schemas w/ external $refs, use --grammar + example/json_schema_to_grammar.py instead
```

## Паспорт аргумента

- Основное имя: `--json-schema`
- Алиасы: `-j`, `--json-schema`
- Тип CLI-значения: строка `SCHEMA`
- Поле в `common_params_sampling`: `grammar`
- Тип grammar: `COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT`
- HTTP-поле: `json_schema`
- OpenAI-compatible path: также может прийти через `response_format`
- Значение по умолчанию: JSON schema отсутствует

## Что меняет в llama-server

CLI-обработчик выполняет `json::parse(value)`, затем `json_schema_to_grammar(...)`, затем записывает результат в `params.sampling.grammar` как output-format grammar. Если JSON невалиден, сервер не стартует.

В server request path поле `json_schema` конвертируется в grammar только если в том же task нет `grammar`. При ошибке конвертации task получает ошибку с префиксом `"json_schema": ...`.

В OpenAI-compatible обработке `response_format` поддерживает `{"type": "json_object"}` и `{"type": "json_schema", ...}`: эти варианты превращаются в `json_schema` до загрузки task params. Если одновременно заданы `json_schema` и непустая `grammar`, этот path бросает `Cannot use both json_schema and grammar`.

## Значения и формат

Значение должно быть валидным JSON, а не YAML и не JavaScript object literal.

Примеры schema:

```json
{}
```

```json
{
  "type": "object",
  "properties": {
    "answer": { "type": "string" },
    "score": { "type": "number" }
  },
  "required": ["answer"],
  "additionalProperties": false
}
```

Поддержка конкретных возможностей schema определяется `common/json-schema-to-grammar.cpp` и тестами `tests/test-json-schema-to-grammar.cpp`: там покрыты object/array/string/number/integer/boolean/null, `enum`, `const`, `anyOf`, `oneOf`, часть `allOf`, `additionalProperties`, internal `$ref` и другие случаи. Для external `$ref` следуйте предупреждению help: заранее конвертируйте schema в grammar и передайте через `--grammar` или `--grammar-file`.

## Когда использовать

Используйте `--json-schema`, если серверный default должен всегда отвечать JSON определенной формы. Для per-request разных схем чаще передавайте `json_schema` в HTTP body, чтобы не запускать отдельный процесс на каждую schema.

Для больших schema и production-конфигов удобнее `--json-schema-file`, чтобы не бороться с shell quoting.

## Влияние на производительность и память

На старте или при разборе request есть стоимость парсинга JSON и конвертации schema в grammar. Во время генерации работает grammar sampler: он не меняет KV-cache и память модели, но добавляет CPU-side фильтрацию токенов и может увеличить sampling latency.

Если сборка включает `LLAMA_USE_LLGUIDANCE`, `json_schema_to_grammar` может вернуть `%llguidance` JSON grammar path; без llguidance используется GBNF builder.

`--backend-sampling` несовместим с grammar: при активной schema grammar backend sampling отключается с warning.

## Взаимодействие с другими аргументами

- `--json-schema-file`: то же преобразование, но schema читается из файла.
- `--grammar` и `--grammar-file`: альтернативные constraint sources. Не задавайте одновременно несколько глобальных constraints, если не хотите зависеть от порядка CLI.
- `--logit-bias`: не может разрешить токен, запрещенный schema-derived grammar.
- `--mirostat`, `--temp`, `--samplers`: выбирают токены внутри пространства, разрешенного grammar.
- `--backend-sampling`: отключается при grammar.

## INI-пресеты и router-режим

`--json-schema` является sampling option и разрешен в `--models-preset`, но inline JSON в INI легко сломать кавычками. Для постоянных preset-ов обычно надежнее `--json-schema-file`.

```ini
[model.json]
json-schema = {"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}
```

HTTP request `json_schema` или OpenAI-style `response_format` может переопределить default grammar для отдельной задачи.

## Типовые проблемы и диагностика

- Сервер не стартует: schema невалидна как JSON или содержит неподдержанную конструкцию converter-а.
- Клиент получает `"json_schema": ...`: ошибка возникла при разборе или конвертации request schema.
- Ответ не соответствует ожидаемому формату prompt-а: schema ограничивает только генерацию; prompt все равно должен просить модель вывести нужный JSON.
- Одновременно заданы `grammar` и `json_schema`: в OpenAI-compatible path это ошибка, в `/completion` task path `grammar` имеет приоритет над `json_schema`.

В debug логах request path печатает `JSON schema:` и `Converted grammar:`.

## Примеры

```bash
llama-server --model /models/model.gguf --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}'
```

```json
{
  "prompt": "Верни JSON с полем answer",
  "json_schema": {
    "type": "object",
    "properties": {
      "answer": { "type": "string" }
    },
    "required": ["answer"],
    "additionalProperties": false
  }
}
```

OpenAI-compatible `response_format`:

```json
{
  "messages": [{ "role": "user", "content": "Верни JSON с полем answer" }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "schema": {
        "type": "object",
        "properties": { "answer": { "type": "string" } },
        "required": ["answer"]
      }
    }
  }
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `-j`/`--json-schema` и CLI conversion.
- `llama.cpp/common/json-schema-to-grammar.cpp`: converter и llguidance/GBNF paths.
- `llama.cpp/tests/test-json-schema-to-grammar.cpp`: покрытые schema features.
- `llama.cpp/tools/server/server-task.cpp`: request поле `json_schema` и conversion diagnostics.
- `llama.cpp/tools/server/server-common.cpp`: `response_format` и конфликт `json_schema` с `grammar`.
- `llama.cpp/tools/server/README.md`: CLI help и request docs.
