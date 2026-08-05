---
schema: 1
primaryName: "--special"
title: "--special"
summary: "Разрешает вывод special/control tokens как текста при detokenization. Полезно для диагностики templates и token streams, но обычно не нужно для публичного API."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "-sp"
  - "--special"
allowedValues: []
env: []
related:
  - "--chat-template"
  - "--reverse-prompt"
---

# --special

## Кратко

`--special` ставит `common_params::special = true`. В server detokenization это разрешает отображать special/control tokens, вместо того чтобы скрывать их как служебные.

Для обычного chat/completions API оставляйте default `false`, иначе клиенты могут увидеть токены вроде BOS/EOS/FIM/chat markers.

## Оригинальная справка llama.cpp

```text
special tokens output enabled (default: false)
```

## Паспорт аргумента

- Основное имя: `--special`
- Алиас: `-sp`
- Тип: флаг без значения
- Поле `common_params`: `special`
- По умолчанию: `false`
- Env: не задан

## Что меняет в llama-server

В generation loop server вызывает `common_token_to_piece(..., special)` и `common_detokenize(..., special)`. При `params_base.special = true` special tokens могут попасть в `text_to_send`, token probabilities и detokenized output.

Для некоторых preserved tokens server может вывести special token даже при default, если token нужен grammar/parser логике; `--special` расширяет это поведение глобально.

## Значения и формат

Это флаг без отдельного значения:

```bash
llama-server --model /models/model.gguf --special
```

Отрицательной формы в `arg.cpp` для этого аргумента нет.

## Когда использовать

- Диагностика chat template, stop tokens и tokenizer behavior.
- Проверка, какие FIM/chat/control markers реально генерирует модель.
- Локальные эксперименты с low-level completions.

Не включайте по умолчанию для OpenAI-compatible публичного endpoint: clients обычно ожидают user-visible text без control tokens.

## Влияние на производительность и память

На inference и память не влияет. Может увеличить размер HTTP response, если модель генерирует много служебных tokens.

## Взаимодействие с другими аргументами

- `--chat-template`: special tokens часто являются частью template delimiters.
- `--reverse-prompt`: если stop sequence содержит special token textual form, включенный `--special` помогает увидеть диагностику, но не обязателен для stop tokenization.
- `/tokenize` request fields `add_special` и `parse_special` независимы от этого флага.

## INI-пресеты и router-режим

В INI пишите `special = true`. В router mode включайте только для диагностической модели/alias, чтобы не менять output contract всех клиентов.

## Типовые проблемы и диагностика

- В ответе появились `<s>`, `</s>`, `<|...|>`: включен `--special` или модель генерирует textual markers как обычный текст.
- Stop sequence не виден в ответе: stop tokens могут быть отфильтрованы до отправки; проверяйте verbose/token logs.
- Клиентский JSON parser не ломается от `--special`, но downstream logic может не ожидать control markers.

## Примеры

```bash
llama-server --model /models/model.gguf --special --verbose
```

## Источники

- `llama.cpp/common/arg.cpp`: `--special`.
- `llama.cpp/common/common.h`: `common_params::special`.
- `llama.cpp/common/common.cpp`: detokenization helpers.
- `llama.cpp/tools/server/server-context.cpp`: token output path.
