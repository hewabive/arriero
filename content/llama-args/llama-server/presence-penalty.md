---
schema: 1
primaryName: "--presence-penalty"
title: "--presence-penalty"
summary: "Добавляет фиксированный штраф за сам факт появления токена в окне `--repeat-last-n`. `0.0` отключает presence penalty."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--presence-penalty"
allowedValues: []
env: []
related:
  - "--repeat-last-n"
  - "--repeat-penalty"
  - "--frequency-penalty"
  - "--samplers"
---

# --presence-penalty

## Кратко

`--presence-penalty` штрафует токен один раз, если он уже присутствует в недавней истории. В отличие от `--frequency-penalty`, этот штраф не растет от количества повторений одного и того же токена.

Default: `0.00`. Значение `0.0` отключает параметр.

## Оригинальная справка llama.cpp

```text
repeat alpha presence penalty (default: 0.00, 0.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--presence-penalty`
- Алиасы: `--presence-penalty`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `penalty_present`
- HTTP-поле: `presence_penalty`
- Значение по умолчанию: `0.00`
- CLI-парсер использует `std::stof`; отдельной проверки диапазона в `arg.cpp` нет.

## Что меняет в llama-server

При старте значение попадает в `params.sampling.penalty_present`. Для отдельного HTTP-запроса сервер читает `presence_penalty` в `task_params::load_from_json`.

Применение происходит только через `llama_sampler_init_penalties`, то есть при активной обычной цепочке samplers. Default chain содержит `penalties` первым сэмплером, поэтому штраф влияет на logits до top-k/top-p/min-p/temperature.

## Значения и формат

- `0.0`: disabled.
- Положительные значения: понижают вероятность уже встречавшихся токенов.
- Малые значения вроде `0.1` - `0.6`: практичнее для общего текста, чем резкие штрафы.
- Отрицательные значения parser принимает, но они будут поощрять уже встречавшиеся токены; используйте только для экспериментов.

## Когда использовать

Параметр полезен, когда модель возвращается к уже упомянутым словам и темам, но не обязательно повторяет их много раз подряд. Для разнообразия идей presence penalty обычно мягче, чем большой `--repeat-penalty`.

Не повышайте его без проверки на форматах с повторяющимися ключами: JSON, YAML, markdown-таблицы и код могут деградировать из-за штрафа структурных токенов и повторных идентификаторов.

## Влияние на производительность и память

Память и KV-cache не меняются. Стоимость такая же класса, как у других penalties: CPU-side sampling по окну `--repeat-last-n`.

## Взаимодействие с другими аргументами

- `--repeat-last-n`: задает историю, где считается присутствие токена.
- `--frequency-penalty`: добавляет штраф, пропорциональный числу появлений; вместе с `--presence-penalty` может быстро переусилить запрет.
- `--repeat-penalty`: multiplicative repeat penalty из того же sampler.
- `--samplers`: при отсутствии `penalties` параметр не используется.
- `--mirostat`: при включенном Mirostat обычный `penalties` sampler из default chain не добавляется.

## INI-пресеты и router-режим

Параметр помечен `set_sampling()`, поэтому подходит для `--models-preset` и remote preset whitelist. В INI:

```ini
[model.default]
presence-penalty = 0.3
```

Per-request JSON `presence_penalty` имеет приоритет над default процесса для конкретной задачи.

## Типовые проблемы и диагностика

- Ответы становятся слишком "новыми" и теряют термины: уменьшите `--presence-penalty`.
- Никакого эффекта: проверьте `--repeat-last-n 0`, отсутствие `penalties` в `--samplers` или `--mirostat 1/2`.
- OpenAI-совместимый клиент может отправлять свое `presence_penalty`; проверяйте фактическое тело запроса.

В логах sampler params печатают `presence_penalty` как `presence_penalty`/`penalty_present` в разных представлениях.

## Примеры

```bash
llama-server --model /models/model.gguf --repeat-last-n 256 --presence-penalty 0.3
```

```json
{
  "prompt": "Предложи 10 разных идей",
  "presence_penalty": 0.4,
  "repeat_last_n": 256
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--presence-penalty`.
- `llama.cpp/common/common.h`: default `penalty_present = 0.00f`.
- `llama.cpp/common/sampling.cpp`: применение через `llama_sampler_init_penalties`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `presence_penalty`.
- `llama.cpp/tools/server/README.md`: описание request-параметра.
