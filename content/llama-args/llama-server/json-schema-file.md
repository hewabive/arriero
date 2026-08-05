---
schema: 1
primaryName: "--json-schema-file"
title: "--json-schema-file"
summary: "Читает JSON Schema из файла, парсит ее на старте и конвертирует в grammar для constrained JSON generation. Ошибка открытия файла или невалидный JSON прерывает запуск."
category: "Параметры сэмплинга"
valueType: "path"
estimation: "normal"
valueHint: "FILE"
aliases:
  - "-jf"
  - "--json-schema-file"
allowedValues: []
env: []
related:
  - "--json-schema"
  - "--grammar"
  - "--grammar-file"
  - "--backend-sampling"
---

# --json-schema-file

## Кратко

`--json-schema-file` загружает JSON Schema из файла и превращает ее в grammar constraint. Это production-friendly вариант `--json-schema`, потому что schema хранится как обычный JSON-файл без shell quoting.

Файл читается при старте `llama-server`; изменения файла после запуска не подхватываются.

## Оригинальная справка llama.cpp

```text
File containing a JSON schema to constrain generations (https://json-schema.org/), e.g. `{}` for any JSON object
For schemas w/ external $refs, use --grammar + example/json_schema_to_grammar.py instead
```

## Паспорт аргумента

- Основное имя: `--json-schema-file`
- Алиасы: `-jf`, `--json-schema-file`
- Тип CLI-значения: путь `FILE`
- Поле в `common_params_sampling`: `grammar`
- Тип grammar: `COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT`
- Значение по умолчанию: JSON schema отсутствует
- Ошибка открытия: `error: failed to open file '<path>'`

## Что меняет в llama-server

CLI открывает файл через `std::ifstream`, читает его полностью в строку, парсит `json::parse(schema)`, конвертирует `json_schema_to_grammar(...)` и сохраняет результат в `params.sampling.grammar`.

На этапе sampling это уже не "файл schema", а grammar constraint. Применение такое же, как у `--json-schema`: grammar sampler фильтрует допустимые токены.

## Значения и формат

Путь должен указывать на файл с валидным JSON Schema. Для управляемых процессов используйте абсолютные пути.

Пример файла:

```json
{
  "type": "object",
  "properties": {
    "answer": { "type": "string" },
    "confidence": { "type": "number" }
  },
  "required": ["answer"],
  "additionalProperties": false
}
```

External `$ref` не является надежным CLI-сценарием по help llama.cpp: для таких схем используйте предварительную конвертацию в grammar и затем `--grammar-file`.

## Когда использовать

Используйте `--json-schema-file`, когда все ответы данного процесса должны быть constrained JSON одной формы: batch extraction, classifier endpoint, structured local API. Для разных схем на каждый запрос лучше HTTP `json_schema` или `response_format`, а не перезапуск процесса.

## Влияние на производительность и память

Старт процесса включает чтение файла, JSON parse и conversion в grammar. Во время генерации стоимость такая же, как у grammar sampler: CPU-side token filtering, без изменения KV-cache, RAM модели и VRAM.

При активной schema `--backend-sampling` отключается, потому что backend sampling несовместим с grammar.

## Взаимодействие с другими аргументами

- `--json-schema`: inline-вариант той же операции.
- `--grammar` и `--grammar-file`: альтернативные constraint sources; не смешивайте без явной причины.
- `--logit-bias`: действует до/вместе с sampler chain, но не отменяет grammar constraint.
- `--mirostat`, `--temp`, `--samplers`: работают внутри множества токенов, разрешенных grammar.

## INI-пресеты и router-режим

Аргумент является sampling option и разрешен в `--models-preset`. Это наиболее удобный вариант для router/model preset:

```ini
[model.extractor]
json-schema-file = /srv/llama/schemas/extract-answer.schema.json
```

Путь должен существовать в окружении subprocess. Если router запускает процессы из другого working directory, относительный путь может сломаться.

## Типовые проблемы и диагностика

- `failed to open file`: неверный путь или права доступа.
- Ошибка JSON parse: файл невалиден как JSON, даже если похож на JavaScript object.
- Constraint не обновился после правки файла: перезапустите `llama-server`.
- Слишком медленная генерация: упростите schema или сравните с `--grammar-file`, если schema conversion создает сложную grammar.

В debug request path для per-request schema печатается converted grammar; для CLI schema-file основной сигнал о проблеме будет на старте.

## Примеры

```bash
llama-server --model /models/model.gguf --json-schema-file /srv/llama/schemas/answer.schema.json
```

Сравнимый per-request вариант без перезапуска процесса:

```json
{
  "prompt": "Верни JSON с answer",
  "json_schema": {
    "type": "object",
    "properties": { "answer": { "type": "string" } },
    "required": ["answer"]
  }
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `-jf`/`--json-schema-file`, чтение файла и conversion.
- `llama.cpp/common/json-schema-to-grammar.cpp`: converter schema в grammar.
- `llama.cpp/tests/test-json-schema-to-grammar.cpp`: покрытые schema features.
- `llama.cpp/common/sampling.cpp`: применение output-format grammar sampler.
- `llama.cpp/tools/server/README.md`: CLI help и request docs.
- `llama.cpp/common/preset.cpp`: sampling args в presets.
