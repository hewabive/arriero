---
schema: 1
primaryName: "--grammar"
title: "--grammar"
summary: "Задает inline GBNF/BNF-like grammar, которая ограничивает допустимые токены генерации. CLI grammar считается пользовательской grammar и не prefill-ится generation prompt-ом."
category: "Параметры сэмплинга"
valueType: "string"
estimation: "normal"
valueHint: "GRAMMAR"
aliases:
  - "--grammar"
allowedValues: []
env: []
related:
  - "--grammar-file"
  - "--json-schema"
  - "--json-schema-file"
  - "--backend-sampling"
  - "--logit-bias"
---

# --grammar

## Кратко

`--grammar` включает grammar-based constrained generation: sampler допускает только токены, которые могут продолжить строку согласно grammar с root-правилом `root`.

Используйте этот аргумент для коротких inline-грамматик. Для длинных правил обычно удобнее `--grammar-file`.

## Оригинальная справка llama.cpp

```text
BNF-like grammar to constrain generations (see samples in grammars/ dir)
```

## Паспорт аргумента

- Основное имя: `--grammar`
- Алиасы: `--grammar`
- Тип CLI-значения: строка `GRAMMAR`
- Поле в `common_params_sampling`: `grammar`
- Тип grammar в `common_grammar`: `COMMON_GRAMMAR_TYPE_USER`
- HTTP-поле: `grammar`
- Значение по умолчанию: grammar отсутствует

## Что меняет в llama-server

CLI записывает строку в `params.sampling.grammar = {COMMON_GRAMMAR_TYPE_USER, value}`. При инициализации sampler `common/sampling.cpp` создает grammar sampler через `llama_sampler_init_grammar(vocab, grammar_str.c_str(), "root")`, если строка не пустая.

Если строка начинается с `%llguidance`, код пытается использовать llguidance backend. Без сборки с `LLAMA_USE_LLGUIDANCE` такой grammar abort-ит процесс с сообщением, что llguidance не включен.

Для user-provided grammar prefill generation prompt не выполняется: `common_grammar_needs_prefill` возвращает true только для output-format и tool-call grammars. Это важно для chat templates: grammar должна описывать именно продолжение, которое модель будет генерировать, а не весь уже сформированный prompt.

## Значения и формат

Значение должно быть текстом grammar с правилом `root`. Простейшая форма:

```text
root ::= "yes" | "no"
```

На CLI из-за пробелов, кавычек и переводов строк безопаснее передавать grammar отдельным argv-значением через arriero или использовать `--grammar-file`. При ручном shell-запуске придется корректно экранировать строку.

## Когда использовать

Используйте `--grammar`, когда нужно жестко ограничить формат ответа: да/нет, enum, небольшой DSL, строка с фиксированным шаблоном. Для JSON чаще проще `--json-schema`, потому что llama.cpp сам преобразует schema в grammar.

Не используйте слишком узкую grammar для открытого диалога: если grammar не допускает нужного продолжения, модель будет вынуждена выбирать из оставшихся токенов, иногда с плохим качеством или ошибкой парсинга grammar.

## Влияние на производительность и память

Grammar не меняет KV-cache и память модели. Она добавляет CPU-side фильтрацию кандидатов при sampling и может повышать latency на токен, особенно на сложных grammar и больших ветвлениях.

При `--backend-sampling` grammar несовместима: `common_sampler_init` пишет warning `backend sampling is not compatible with grammar, disabling` и отключает backend sampling для задачи.

## Взаимодействие с другими аргументами

- `--grammar-file`: альтернативный способ загрузить user grammar из файла; последний CLI-аргумент, записавший `params.sampling.grammar`, определяет active grammar.
- `--json-schema` и `--json-schema-file`: преобразуют JSON schema в output-format grammar. На CLI они также пишут в `params.sampling.grammar`; не задавайте несколько constraint-источников одновременно.
- `--logit-bias`: может менять вероятности, но grammar жестко запрещает недопустимые токены.
- `--backend-sampling`: отключается при наличии grammar.
- `--mirostat` и `--samplers`: grammar применяется отдельно от sampler chain и остается ограничением.

## INI-пресеты и router-режим

`--grammar` помечен как sampling option, значит разрешен в `--models-preset`. В INI многострочные grammar могут быть неудобны; лучше использовать `--grammar-file`, если preset tooling не сохраняет переносы надежно.

```ini
[model.classifier]
grammar = root ::= "yes" | "no"
```

HTTP-запрос с полем `grammar` может переопределить default процесса. В `/completion` path, если одновременно переданы `json_schema` и `grammar`, server task выбирает ветку `grammar`; в OpenAI-compatible преобразовании есть отдельная проверка, которая запрещает одновременные `json_schema` и `grammar`.

## Типовые проблемы и диагностика

- Ошибка `Failed to parse grammar`: grammar синтаксически некорректна или нет ожидаемого `root`.
- Ответ обрывается или выглядит странно: grammar слишком узкая для фактического prompt/chat template.
- Backend sampling отключился: это ожидаемо при grammar.
- `%llguidance` grammar падает при старте: бинарник собран без `LLAMA_USE_LLGUIDANCE`.

В debug логах server task печатает `Grammar (...)` и саму grammar, если поле пришло через HTTP.

## Примеры

```bash
llama-server --model /models/model.gguf --grammar 'root ::= "yes" | "no"'
```

```json
{
  "prompt": "Ответь yes или no: 2 + 2 = 4?",
  "grammar": "root ::= \"yes\" | \"no\""
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--grammar`.
- `llama.cpp/common/common.h`: `common_grammar`, типы grammar и `common_grammar_needs_prefill`.
- `llama.cpp/common/sampling.cpp`: создание grammar sampler, llguidance path, prefill logic и incompatibility с backend sampling.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `grammar`, `grammar_lazy`, triggers и диагностика.
- `llama.cpp/tools/server/README.md`: CLI help и пример ошибки invalid grammar.
