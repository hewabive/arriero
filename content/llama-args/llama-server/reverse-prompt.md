---
schema: 1
primaryName: "--reverse-prompt"
title: "--reverse-prompt"
summary: "Добавляет stop/anti-prompt строку, на которой generation останавливается. В server это становится default stop sequence для completion/chat задач, если request не передал собственный `stop`."
category: "Параметры llama-server"
valueType: "string"
valueHint: "PROMPT"
aliases:
  - "-r"
  - "--reverse-prompt"
allowedValues: []
env: []
related:
  - "--escape"
  - "--chat-template"
---

# --reverse-prompt

## Кратко

`--reverse-prompt` добавляет строку в `common_params::antiprompt`. В server defaults она попадает в `server_task_params::antiprompt` и используется как stop sequence, если конкретный request не передал свои `stop`.

Аргумент можно указывать несколько раз: каждая строка добавляется в список.

## Оригинальная справка llama.cpp

```text
halt generation at PROMPT, return control in interactive mode
```

## Паспорт аргумента

- Основное имя: `--reverse-prompt`
- Алиас: `-r`
- Значение: строка `PROMPT`
- Поле `common_params`: `antiprompt`
- Этап применения: CLI parse, затем defaults server tasks
- Env: не задан

## Что меняет в llama-server

В `server-task.cpp` defaults берут `params_base.antiprompt`. При разборе request поле `stop` токенизируется с `parse_special=true`; если request stop пустой, применяется default antiprompt из CLI.

В отличие от интерактивного CLI, server не "возвращает управление пользователю" в терминале. Для HTTP API смысл практический: остановить генерацию на заданной строке.

## Значения и формат

Строка сравнивается как stop text/tokenized sequence. Если включен `--escape`, для `antiprompt` применяются escapes `\n`, `\r`, `\t`, `\'`, `\"`, `\\` после парсинга CLI.

Для special-token stop sequences используйте точные textual forms и проверяйте модельный tokenizer; server tokenizes stops с `parse_special=true`.

## Когда использовать

- Модель не имеет корректных stop tokens в template.
- Нужно остановить completion на пользовательском delimiter.
- Нужно задать server-wide fallback stop для клиентов, которые не отправляют `stop`.

Не задавайте слишком общие строки вроде `.` или `\n`: они будут преждевременно обрывать ответы.

## Влияние на производительность и память

На память модели не влияет. Проверка stop sequences добавляет небольшую runtime-логику. Слишком длинный список stop strings может немного увеличить post-processing каждого токена.

## Взаимодействие с другими аргументами

- `--escape`: обрабатывает escapes внутри reverse prompts.
- `--chat-template`: многие chat templates уже добавляют stop sequences; дополнительный `--reverse-prompt` может конфликтовать.
- Request field `stop`: если клиент передает непустой `stop`, он заменяет CLI defaults для этой задачи.

## INI-пресеты и router-режим

В INI используйте `reverse-prompt = ...`; для нескольких stop sequences проверьте, как arriero сериализует повторяющиеся аргументы. В router mode задавайте per-model, потому что delimiters зависят от tokenizer/template.

## Типовые проблемы и диагностика

- Ответы обрываются слишком рано: stop string слишком общий или появляется в нормальном тексте.
- Stop не срабатывает: проверьте escapes, special token parsing и то, не переопределил ли request поле `stop`.
- При `--verbose` проверяйте итоговые request params, где stop list попадает в task.

## Примеры

```bash
llama-server --model /models/model.gguf --reverse-prompt "<|im_end|>"
```

```bash
llama-server --model /models/model.gguf --reverse-prompt "### User:"
```

## Источники

- `llama.cpp/common/arg.cpp`: `--reverse-prompt`, escape post-processing.
- `llama.cpp/common/common.h`: `common_params::antiprompt`.
- `llama.cpp/tools/server/server-task.cpp`: defaults и request `stop`.
- `llama.cpp/tools/server/README.md`: server argument table.
