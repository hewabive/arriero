---
schema: 1
primaryName: "--dry-base"
title: "--dry-base"
summary: "Задает базу экспоненциального роста DRY penalty. Значения меньше `1.0` не принимаются как новое значение: CLI их игнорирует, HTTP task возвращает default."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--dry-base"
allowedValues: []
env: []
related:
  - "--dry-multiplier"
  - "--dry-allowed-length"
  - "--dry-penalty-last-n"
  - "--dry-sequence-breaker"
---

# --dry-base

## Кратко

`--dry-base` управляет тем, насколько быстро растет DRY penalty после превышения `--dry-allowed-length`. Чем выше base, тем резче DRY давит длинные повторяющиеся последовательности.

Default: `1.75`.

## Оригинальная справка llama.cpp

```text
set DRY sampling base value (default: 1.75)
```

## Паспорт аргумента

- Основное имя: `--dry-base`
- Алиасы: `--dry-base`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `dry_base`
- HTTP-поле: `dry_base`
- Значение по умолчанию: `1.75`
- CLI: значение применяется только если `potential_base >= 1.0f`
- HTTP task: если `dry_base < 1.0f`, сервер заменяет его на default `defaults.sampling.dry_base`

## Что меняет в llama-server

Параметр передается в `llama_sampler_init_dry` вместе с multiplier, allowed length, окном истории и sequence breakers. Сам по себе `--dry-base` не включает DRY: если `--dry-multiplier 0`, DRY остается фактически выключенным.

## Значения и формат

- `1.75`: default llama.cpp.
- `1.0`: штраф перестает расти экспоненциально с длиной повтора, остается масштаб multiplier.
- Больше `1.0`: чем выше значение, тем быстрее усиливается штраф на длинных повторах.
- Меньше `1.0`: не используйте. CLI молча не меняет ранее установленное значение, HTTP task откатывает к default.

Формула из README: `multiplier * base ^ (length of repeating sequence before token - allowed length)`.

## Когда использовать

Увеличивайте `--dry-base`, если короткие повторы допустимы, но длинные циклы нужно останавливать жестче. Уменьшайте ближе к `1.0`, если DRY слишком резко обрывает допустимые повторяемые структуры.

Обычно сначала подбирают `--dry-multiplier`, затем корректируют `--dry-base`.

## Влияние на производительность и память

Память не меняется. CPU overhead DRY определяется главным образом поиском повторов и окном `--dry-penalty-last-n`; сама база влияет на величину штрафа, а не на размер KV-cache.

## Взаимодействие с другими аргументами

- `--dry-multiplier`: должен быть больше `0`, иначе base не имеет практического эффекта.
- `--dry-allowed-length`: определяет, с какой длины повтора формула начинает штрафовать.
- `--dry-penalty-last-n`: ограничивает историю поиска повторов.
- `--samplers`: default содержит `dry`; при удалении `dry` параметр не применяется.
- `--mirostat`: при `--mirostat 1/2` default DRY sampler не добавляется.

## INI-пресеты и router-режим

Аргумент разрешен в `--models-preset`, так как он sampling option:

```ini
[model.default]
dry-multiplier = 0.8
dry-base = 1.5
```

Для HTTP-запроса поле называется `dry_base`.

## Типовые проблемы и диагностика

- Значение меньше `1.0` "не сработало": это ожидаемо по коду. Используйте `1.0` или больше.
- DRY слишком агрессивен на длинных ответах: уменьшите `--dry-base` или `--dry-multiplier`.
- Нет эффекта: проверьте `dry_multiplier`, `--samplers` и `--mirostat`.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.7 --dry-base 1.5
```

```json
{
  "prompt": "Сгенерируй длинный ответ",
  "dry_multiplier": 0.7,
  "dry_base": 1.5
}
```

## Источники

- `llama.cpp/common/arg.cpp`: проверка `dry_base >= 1.0f` в CLI.
- `llama.cpp/common/common.h`: default `dry_base = 1.75f`.
- `llama.cpp/common/sampling.cpp`: передача `dry_base` в `llama_sampler_init_dry`.
- `llama.cpp/tools/server/server-task.cpp`: HTTP fallback для `dry_base < 1.0f`.
- `llama.cpp/tools/server/README.md`: формула DRY penalty.
