---
schema: 1
primaryName: "--dry-sequence-breaker"
title: "--dry-sequence-breaker"
summary: "Добавляет строку-разделитель для DRY и при первом использовании очищает default breakers. Значение `none` на CLI оставляет DRY без sequence breakers."
category: "Параметры сэмплинга"
valueType: "string"
estimation: "normal"
valueHint: "STRING"
aliases:
  - "--dry-sequence-breaker"
allowedValues: []
env: []
related:
  - "--dry-multiplier"
  - "--dry-base"
  - "--dry-allowed-length"
  - "--dry-penalty-last-n"
---

# --dry-sequence-breaker

## Кратко

`--dry-sequence-breaker` настраивает строки, которые DRY считает границами последовательностей. Default breakers в `common.h`: newline, `:`, `"`, `*`.

На CLI первое использование `--dry-sequence-breaker` очищает default список, затем добавляет переданное значение. Аргумент можно повторять.

## Оригинальная справка llama.cpp

```text
add sequence breaker for DRY sampling, clearing out default breakers ('\n', ':', '"', '*') in the process; use "none" to not use any sequence breakers
```

## Паспорт аргумента

- Основное имя: `--dry-sequence-breaker`
- Алиасы: `--dry-sequence-breaker`
- Тип CLI-значения: строка `STRING`
- Поле в `common_params_sampling`: `dry_sequence_breakers`
- HTTP-поле: `dry_sequence_breakers`
- Значение по умолчанию: `["\n", ":", "\"", "*"]`
- CLI special value: `none` очищает список и не добавляет breaker.
- HTTP: если поле `dry_sequence_breakers` передано, оно должно быть непустым массивом строк.

## Что меняет в llama-server

Список строк преобразуется в массив `const char *` и передается в `llama_sampler_init_dry`. Breakers влияют только на DRY sampler и не меняют обычные `penalties`.

CLI-обработчик использует состояние "defaults cleared": первый `--dry-sequence-breaker` очищает default breakers, последующие добавляют значения в уже очищенный список. Поэтому для набора из двух breakers указывайте аргумент два раза.

## Значения и формат

- `--dry-sequence-breaker "\n"`: использовать перевод строки как breaker.
- `--dry-sequence-breaker ":"`: использовать двоеточие.
- `--dry-sequence-breaker none`: очистить список breakers.
- Повтор аргумента: добавить еще одну строку после первого очищения default.

В JSON request формат другой:

```json
{
  "dry_sequence_breakers": ["\n", ":"]
}
```

Пустой массив в HTTP task отклоняется: `Error: dry_sequence_breakers must be a non-empty array of strings`.

## Когда использовать

Меняйте breakers, если DRY неправильно связывает повторы через границы абзацев, markdown-списков, JSON ключей или строк кода. Default набор ориентирован на типичные текстовые и разметочные границы.

`none` полезен только для экспериментов: без breakers DRY может связывать повторы через большие структурные границы и становиться более агрессивным.

## Влияние на производительность и память

Память модели и KV-cache не меняются. Количество breakers небольшое; основной overhead DRY задается окном `--dry-penalty-last-n`.

## Взаимодействие с другими аргументами

- `--dry-multiplier`: при `0` breakers не имеют практического эффекта.
- `--dry-allowed-length` и `--dry-base`: задают, когда и насколько штрафовать продолжения последовательности.
- `--dry-penalty-last-n`: задает окно поиска повторов.
- `--samplers`: должен содержать `dry`.
- `--mirostat`: при `--mirostat 1/2` default DRY sampler не создается.

## INI-пресеты и router-режим

Аргумент является sampling option и может использоваться в `--models-preset`. Из-за повторяемости CLI-аргумента убедитесь, что ваш INI/preset tooling поддерживает несколько значений одного ключа. Если поддерживается только одно значение, задавайте один breaker или используйте per-request JSON `dry_sequence_breakers`.

```ini
[model.default]
dry-sequence-breaker = "\n"
```

## Типовые проблемы и диагностика

- Ожидали добавить breaker к default, но default исчез: это нормальная CLI-семантика. Первый `--dry-sequence-breaker` очищает default список.
- HTTP-запрос с пустым массивом падает: в server task пустой `dry_sequence_breakers` запрещен.
- DRY стал слишком агрессивным после `none`: верните хотя бы newline breaker.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-sequence-breaker "\n" --dry-sequence-breaker ":"
```

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-sequence-breaker none
```

```json
{
  "prompt": "Сгенерируй markdown",
  "dry_multiplier": 0.8,
  "dry_sequence_breakers": ["\n", ":", "*"]
}
```

## Источники

- `llama.cpp/common/arg.cpp`: CLI-семантика очистки default breakers и `none`.
- `llama.cpp/common/common.h`: default `dry_sequence_breakers`.
- `llama.cpp/common/sampling.cpp`: передача breakers в `llama_sampler_init_dry`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `dry_sequence_breakers` и запрет пустого массива.
- `llama.cpp/tools/server/README.md`: описание CLI и request-поля.
