---
schema: 1
primaryName: "--escape"
title: "--escape"
summary: "Включает или отключает обработку escape-последовательностей в prompt-related CLI строках. По умолчанию включено; `--no-escape` оставляет `\\n`, `\\t` и похожие последовательности буквальным текстом."
category: "Общие параметры"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "-e"
  - "--escape"
  - "--no-escape"
allowedValues: []
env: []
related:
  - "--reverse-prompt"
---

# --escape

## Кратко

`--escape` управляет `common_params::escape`. Если включено, после CLI parsing llama.cpp вызывает `string_process_escapes()` для `prompt`, `input_prefix`, `input_suffix`, каждого `antiprompt` и `sampler.dry_sequence_breakers`.

В server чаще всего заметно для `--reverse-prompt`: строка `\n### User:` может стать stop sequence с реальным переводом строки.

## Оригинальная справка llama.cpp

```text
whether to process escapes sequences (\n, \r, \t, \', \", \\) (default: true)
```

## Паспорт аргумента

- Основное имя: `--escape`
- Алиас: `-e`
- Отрицательная форма: `--no-escape`
- Поле `common_params`: `escape`
- По умолчанию: `true`
- Env: не задан

## Что меняет в llama-server

Это preprocessing CLI-строк до старта server runtime. Аргумент не обрабатывает JSON body входящих HTTP запросов и не меняет escaping внутри `--chat-template-kwargs` или `--reasoning-budget-message`.

## Значения и формат

Boolean-pair:

- `--escape`: включить обработку;
- `--no-escape`: отключить.

Поддерживаемые escape sequences перечислены в справке: `\n`, `\r`, `\t`, `\'`, `\"`, `\\`.

## Когда использовать

Оставляйте default включенным, если задаете multiline prompt или stop strings через CLI. Используйте `--no-escape`, если обратный слеш должен попасть в модель буквально, например в code/test prompts.

## Влияние на производительность и память

Нет runtime-влияния на inference. Обработка выполняется один раз после парсинга аргументов.

## Взаимодействие с другими аргументами

- `--reverse-prompt`: escapes применяются к каждому antiprompt.
- `--in-prefix` и `--in-suffix`: escapes применяются к prefix/suffix, хотя это больше относится к completion/infill режимам.
- `--chat-template`, `--chat-template-file`, `--chat-template-kwargs`: этим аргументом не обрабатываются.

## INI-пресеты и router-режим

В INI используйте `escape = true` или `no-escape = true`. Для router mode настройка применяется к argv subprocess и влияет на CLI defaults этой модели.

## Типовые проблемы и диагностика

- Stop sequence `\n` не срабатывает: проверьте, не был ли задан `--no-escape`.
- В prompt видны буквальные `\n`: escape processing отключен или строка пришла через JSON body, где это отдельная JSON-ответственность клиента.
- Нужен literal backslash: используйте `--no-escape` или экранируйте `\\` с учетом shell/INI слоя.

## Примеры

```bash
llama-server --model /models/model.gguf --reverse-prompt "\n### User:"
```

```bash
llama-server --model /models/model.gguf --no-escape --reverse-prompt "\n### User:"
```

## Источники

- `llama.cpp/common/arg.cpp`: `--escape`, `--no-escape`, post-processing строк.
- `llama.cpp/common/common.cpp`: `string_process_escapes()`.
- `llama.cpp/common/common.h`: `common_params::escape`.
