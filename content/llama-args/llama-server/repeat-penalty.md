---
schema: 1
primaryName: "--repeat-penalty"
title: "--repeat-penalty"
summary: "Задает множитель штрафа для токенов, которые уже встречались в окне `--repeat-last-n`. Значение `1.0` отключает этот вид штрафа."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--repeat-penalty"
allowedValues: []
env: []
related:
  - "--repeat-last-n"
  - "--presence-penalty"
  - "--frequency-penalty"
  - "--samplers"
---

# --repeat-penalty

## Кратко

`--repeat-penalty` снижает вероятность токенов, которые уже были в недавней истории генерации. Это базовый антизацикливающий штраф llama.cpp.

Default в текущем `common.h` и CLI help: `1.00`. `1.0` отключает множитель, значения выше `1.0` усиливают подавление повторов.

## Оригинальная справка llama.cpp

```text
penalize repeat sequence of tokens (default: 1.00, 1.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--repeat-penalty`
- Алиасы: `--repeat-penalty`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `penalty_repeat`
- HTTP-поле: `repeat_penalty`
- Значение по умолчанию: `1.00`
- Специальное значение: `1.0` отключает repeat penalty
- CLI-парсер использует `std::stof`; отдельной проверки диапазона в `arg.cpp` нет.

## Что меняет в llama-server

CLI-аргумент записывается в `params.sampling.penalty_repeat` и помечает sampling config как явно заданный. Для каждого request `server-task.cpp` читает JSON-поле `repeat_penalty`, если оно передано, иначе оставляет default процесса.

При `--mirostat 0` и наличии `penalties` в `--samplers` значение передается в `llama_sampler_init_penalties` вместе с `penalty_last_n`, `penalty_freq` и `penalty_present`. Штраф применяется на этапе sampling после получения logits и до финального выбора токена.

## Значения и формат

- `1.0`: disabled.
- `1.05` - `1.15`: мягкий диапазон для уменьшения повторов без сильного искажения стиля.
- Значения существенно выше `1.2`: могут заставить модель избегать нужных повторов, терминов, имен и структурных токенов.
- Значения ниже `1.0`: парсер принимает, но это уже не типичный анти-repeat режим; проверяйте на своей модели.

## Когда использовать

Используйте `--repeat-penalty`, если ответы уходят в повтор одной строки, списка, шаблонной фразы или одинакового markdown-блока. Начинайте с небольшого изменения, например `1.05` или `1.08`, и оценивайте на одинаковом prompt с фиксированным `--seed`.

Для JSON, кода и таблиц не ставьте высокий repeat penalty глобально: в таких форматах повтор ключей, скобок, переносов и идентификаторов часто нормален.

## Влияние на производительность и память

Память модели, KV-cache и VRAM не меняются. CPU overhead зависит от включенного `penalties` sampler и окна `--repeat-last-n`; обычно он мал, но растет с большим окном и числом одновременных слотов.

## Взаимодействие с другими аргументами

- `--repeat-last-n`: задает окно, внутри которого ищутся повторы. При `--repeat-last-n 0` эффект `--repeat-penalty` исчезает.
- `--presence-penalty` и `--frequency-penalty`: добавочные штрафы OpenAI-style, применяются тем же `penalties` sampler.
- `--samplers`: должен содержать `penalties`; default содержит его первым.
- `--mirostat`: при `--mirostat 1` или `--mirostat 2` обычная цепочка `params.samplers` не создается, поэтому default `penalties` не применяется.
- `--logit-bias`: применяется до обычной sampler chain и может компенсировать или усилить запрет отдельных токенов.

## INI-пресеты и router-режим

`--repeat-penalty` является sampling option и разрешен в `--models-preset`. В INI:

```ini
[model.default]
repeat-penalty = 1.08
```

В router/model-preset режиме это стартовый default для выбранной модели. Запрос с JSON-полем `repeat_penalty` переопределяет его только для этой генерации.

## Типовые проблемы и диагностика

- Параметр выставлен, но повтор не меняется: проверьте `--repeat-last-n`, `--samplers` и `--mirostat`.
- Модель перестала повторять нужные ключи или имена: снижайте `--repeat-penalty` ближе к `1.0` или уменьшайте `--repeat-last-n`.
- Разные клиенты дают разное поведение: некоторые отправляют `repeat_penalty` per request и тем самым перекрывают CLI default.

В debug/trace логах ищите `sampler params` и поле `repeat_penalty`.

## Примеры

```bash
llama-server --model /models/model.gguf --repeat-last-n 128 --repeat-penalty 1.08
```

```json
{
  "prompt": "Продолжи текст без повторов",
  "repeat_last_n": 128,
  "repeat_penalty": 1.08
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--repeat-penalty` и запись в `penalty_repeat`.
- `llama.cpp/common/common.h`: default `penalty_repeat = 1.00f`.
- `llama.cpp/common/sampling.cpp`: `llama_sampler_init_penalties`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `repeat_penalty`.
- `llama.cpp/tools/server/README.md`: CLI и request-документация sampling-параметров.
