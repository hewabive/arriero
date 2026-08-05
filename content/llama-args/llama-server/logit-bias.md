---
schema: 1
primaryName: "--logit-bias"
title: "--logit-bias"
summary: "Сдвигает logit конкретного token id до остальных CPU samplers. CLI принимает форму `TOKEN_ID+BIAS` или `TOKEN_ID-BIAS`; HTTP API дополнительно принимает массивы, строки и OpenAI-style объект."
category: "Параметры сэмплинга"
valueType: "string"
estimation: "normal"
valueHint: "TOKEN_ID(+/-)BIAS"
aliases:
  - "-l"
  - "--logit-bias"
allowedValues: []
env: []
related:
  - "--ignore-eos"
  - "--samplers"
  - "--grammar"
  - "--json-schema"
---

# --logit-bias

## Кратко

`--logit-bias` добавляет положительный или отрицательный сдвиг к logit выбранного token id. Это точечный способ повысить, снизить или почти запретить вероятность конкретных токенов.

CLI-формат отличается от HTTP API: на CLI нужен token id и знак, например `15043+1` или `15043-1`.

## Оригинальная справка llama.cpp

```text
modifies the likelihood of token appearing in the completion,
i.e. `--logit-bias 15043+1` to increase likelihood of token ' Hello',
or `--logit-bias 15043-1` to decrease likelihood of token ' Hello'
```

## Паспорт аргумента

- Основное имя: `--logit-bias`
- Алиасы: `-l`, `--logit-bias`
- Тип CLI-значения: `TOKEN_ID(+/-)BIAS`
- Поле в `common_params_sampling`: `logit_bias`
- HTTP-поле: `logit_bias`
- Значение по умолчанию: пустой список `[]`
- CLI parse: `std::stringstream` читает integer token id, затем знак `+` или `-`, затем float bias.
- Ошибка CLI-формата: `invalid input format`.

## Что меняет в llama-server

CLI-аргумент добавляет элемент `{token, bias}` в `params.sampling.logit_bias`. Аргумент можно повторять, чтобы добавить несколько bias-правил.

В `common_sampler_init` logit bias sampler добавляется перед обычной sampler chain: `llama_sampler_init_logit_bias(llama_vocab_n_tokens(vocab), params.logit_bias.size(), params.logit_bias.data())`. После этого могут применяться Mirostat или обычные samplers, а grammar может дополнительно отфильтровать недопустимые токены.

В server request path `server-task.cpp` сначала очищает `params.sampling.logit_bias`, затем парсит JSON-поле `logit_bias`. Если `ignore_eos` включен, сервер добавляет заранее рассчитанные EOG-token biases в тот же список.

## Значения и формат

CLI:

- `--logit-bias 15043+1`: повысить logit token id `15043` на `1`.
- `--logit-bias 15043-1`: понизить logit token id `15043` на `1`.
- Знак обязателен. Значение без `+` или `-` не пройдет parser.

HTTP API поддерживает больше форм:

- `[[15043, 1.0]]`: bias по token id.
- `[["Hello", -0.5]]`: строка токенизируется, bias применяется ко всем полученным токенам.
- `[[15043, false]]`: boolean `false` превращается в `-INFINITY`, то есть фактический запрет токена.
- `{"15043": 1.0, "Hello": -0.5}`: OpenAI-compatible object.

В HTTP numeric token id принимается только если он в диапазоне `0 <= tok < n_vocab`. Некорректные элементы массива в текущем коде в основном пропускаются, а не всегда приводят к ошибке.

## Когда использовать

Используйте `--logit-bias`, когда нужно точечно запретить или предпочесть конкретный токен: например, подавить нежелательный специальный маркер, повысить вероятность фиксированного разделителя или протестировать поведение tokenizer. Для запрета слов через CLI сначала найдите token id конкретной модели; строковый формат на CLI не поддерживается.

Не используйте большой положительный bias как замену prompt engineering: модель может начать форсировать токен в неподходящих местах.

## Влияние на производительность и память

Память модели и KV-cache не меняются. CPU overhead пропорционален числу bias-правил и обычно мал. Большой список строковых HTTP bias может быть дороже на этапе разбора запроса из-за токенизации строк.

## Взаимодействие с другими аргументами

- `--ignore-eos`: добавляет EOG-token biases к `logit_bias`.
- `--grammar`, `--grammar-file`, `--json-schema`, `--json-schema-file`: grammar может полностью запретить токен, даже если `--logit-bias` его повышает.
- `--mirostat` и `--samplers`: работают после logit bias sampler; bias влияет на распределение, которое они получают.
- `--temp`: при очень низкой temperature даже небольшой bias может заметно менять результат.

## INI-пресеты и router-режим

`--logit-bias` помечен как sampling option и разрешен в `--models-preset`. Если нужно несколько правил, убедитесь, что INI/preset слой поддерживает повторяющийся ключ:

```ini
[model.default]
logit-bias = 15043-2
```

Для per-request настройки чаще удобнее JSON `logit_bias`, потому что он поддерживает массив правил и строковые ключи.

## Типовые проблемы и диагностика

- `invalid input format`: на CLI не хватает знака или token id не integer.
- Bias не действует на слово: слово может состоять из нескольких токенов; CLI работает только с одним token id за раз.
- Запрет конфликтует с grammar: grammar имеет жесткое ограничение допустимых токенов и может пересэмплировать.
- OpenAI-style клиент отправляет объект: это поддерживается в server request path, но не является CLI-форматом.

В JSON ответа task params `logit_bias` форматируется как массив объектов `{ "token": ..., "bias": ... }`.

## Примеры

```bash
llama-server --model /models/model.gguf --logit-bias 15043-2
```

```bash
llama-server --model /models/model.gguf -l 15043+1 -l 2-100
```

```json
{
  "prompt": "Say hello",
  "logit_bias": [
    ["Hello", 1.0],
    [15043, -1.0]
  ]
}
```

## Источники

- `llama.cpp/common/arg.cpp`: CLI parser `-l`/`--logit-bias`.
- `llama.cpp/common/common.h`: поля `logit_bias` и `logit_bias_eog`.
- `llama.cpp/common/sampling.cpp`: добавление `llama_sampler_init_logit_bias`.
- `llama.cpp/tools/server/server-task.cpp`: HTTP formats для `logit_bias` и взаимодействие с `ignore_eos`.
- `llama.cpp/tools/server/README.md`: описание JSON `logit_bias`.
