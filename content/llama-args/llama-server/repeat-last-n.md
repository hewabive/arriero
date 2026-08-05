---
schema: 1
primaryName: "--repeat-last-n"
title: "--repeat-last-n"
summary: "Задает размер окна предыдущих токенов, по которому llama-server считает обычные repeat/frequency/presence penalties. `0` отключает это окно; отрицательные значения больше не принимаются."
category: "Параметры сэмплинга"
valueType: "number"
valueHint: "N"
aliases:
  - "--repeat-last-n"
allowedValues: []
env: []
related:
  - "--repeat-penalty"
  - "--presence-penalty"
  - "--frequency-penalty"
  - "--samplers"
---

# --repeat-last-n

## Кратко

`--repeat-last-n` управляет тем, сколько последних токенов учитывать в сэмплере `penalties`. Это не длина ответа и не размер контекста модели, а окно истории для штрафов повторения.

Значение по умолчанию: `64`. `0` отключает применение penalties по истории. В актуальном llama.cpp отрицательные значения, включая прежнее специальное значение `-1`, отклоняются.

## Оригинальная справка llama.cpp

```text
last n tokens to consider for penalize (default: 64, 0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--repeat-last-n`
- Алиасы: `--repeat-last-n`
- Тип CLI-значения: целое число `N`
- Поле в `common_params_sampling`: `penalty_last_n`
- HTTP-поле для `/completion` и совместимых server routes: `repeat_last_n`
- Значение по умолчанию в `common.h`: `64`
- Проверка CLI: любое значение меньше `0` отклоняется как `invalid repeat-last-n`
- Проверка HTTP task: любое значение меньше `0` отклоняется как `Error: repeat_last_n must be >= 0`

## Что меняет в llama-server

При старте CLI-парсер записывает значение в `params.sampling.penalty_last_n`. При обработке HTTP-запроса `tools/server/server-task.cpp` может переопределить его из JSON-поля `repeat_last_n`; если в запросе поля нет, используется серверный default, полученный из CLI.

Сэмплер создается для конкретной задачи/слота в `common_sampler_init`. Если `--mirostat 0`, цепочка сэмплеров по умолчанию начинается с `penalties`, затем идет `dry`, затем `top_k`/`top_p`/`min_p`/`temperature` и другие фильтры. Для `penalties` llama.cpp вызывает `llama_sampler_init_penalties(params.penalty_last_n, params.penalty_repeat, params.penalty_freq, params.penalty_present)`.

Дополнительно CLI-обработчик поднимает `params.sampling.n_prev` как минимум до `penalty_last_n`. Это нужно для локального ring buffer предыдущих токенов, который пополняется в `common_sampler_accept`.

## Значения и формат

- `64`: default, небольшой локальный контроль повторов.
- `0`: отключает окно penalties. На практике это выключает эффект `--repeat-penalty`, `--presence-penalty` и `--frequency-penalty`, даже если их коэффициенты заданы.
- Положительное число: проверять не больше указанного числа последних токенов.
- Отрицательное число: ошибка на CLI или при разборе HTTP task.

## Когда использовать

Увеличивайте `--repeat-last-n`, если модель зацикливается на фразах, списках или одинаковых абзацах через расстояние больше 64 токенов. Уменьшайте значение, если ответы становятся слишком осторожными, модель избегает нужной терминологии или плохо повторяет имена, ключи JSON и кодовые идентификаторы.

Для длинных творческих ответов часто полезно окно больше `64`. Для кода, JSON и задач с обязательными повторяющимися ключами слишком большое окно может мешать.

## Влияние на производительность и память

Параметр не меняет KV-cache, RAM под модель или VRAM. Он влияет на CPU-side sampling: чем больше окно, тем больше история, которую должен учитывать penalties sampler. Обычно это малая часть latency по сравнению с eval модели, но при очень большом окне, большом vocab и высокой конкуренции слотов overhead может стать заметен.

Размер окна ограничен явным неотрицательным числом и не растёт автоматически вместе с контекстом.

## Взаимодействие с другими аргументами

- `--repeat-penalty`, `--presence-penalty`, `--frequency-penalty`: коэффициенты штрафа, которые работают внутри окна `--repeat-last-n`.
- `--samplers`: если из цепочки убрать `penalties`, этот аргумент не будет влиять на sampling.
- `--mirostat`: при `--mirostat 1` или `--mirostat 2` обычная цепочка `params.samplers` не используется, поэтому `penalties` из default chain не добавляется.
- `--ctx-size` и `--parallel` больше не разворачивают специальное значение `-1`: для большого окна его размер нужно задать явно.

## INI-пресеты и router-режим

Аргумент помечен как sampling option через `set_sampling()`, поэтому он допустим в `--models-preset`; `common/preset.cpp` автоматически разрешает sampling-параметры даже для remote preset whitelist. В INI используйте ключ без ведущих дефисов:

```ini
[model.default]
repeat-last-n = 128
```

В router/model-preset сценарии это default для процесса с конкретной моделью. Клиентский JSON-запрос с `repeat_last_n` может переопределить его для отдельной генерации.

## Типовые проблемы и диагностика

- Ошибка старта с `invalid repeat-last-n`: передано отрицательное число.
- Ошибка HTTP-запроса `repeat_last_n must be >= 0`: клиент отправил отрицательное JSON-значение.
- Параметр не меняет поведение: проверьте, что в `--samplers` есть `penalties` и что `--mirostat` равен `0`.
- Повторы все еще есть: увеличивайте не только окно, но и сами коэффициенты `--repeat-penalty`, `--presence-penalty` или `--frequency-penalty`.

В trace/debug логах полезна строка `sampler params`, где печатается `repeat_last_n`, `repeat_penalty`, `frequency_penalty` и `presence_penalty`.

## Примеры

```bash
llama-server --model /models/model.gguf --repeat-last-n 128 --repeat-penalty 1.08
```

```bash
llama-server --model /models/model.gguf --ctx-size 8192 --repeat-last-n 8192 --repeat-penalty 1.05
```

Пример per-request override:

```json
{
  "prompt": "Напиши краткое резюме",
  "repeat_last_n": 256,
  "repeat_penalty": 1.08
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--repeat-last-n`, проверка CLI и `set_sampling()`.
- `llama.cpp/common/common.h`: default `penalty_last_n = 64` и default цепочка `samplers`.
- `llama.cpp/common/sampling.cpp`: создание `llama_sampler_init_penalties` и печать sampler params.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `repeat_last_n` и проверка `>= 0`.
- `llama.cpp/tools/server/README.md`: CLI help и описание request-параметра `repeat_last_n`.
