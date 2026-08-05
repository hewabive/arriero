---
schema: 1
primaryName: "--frequency-penalty"
title: "--frequency-penalty"
summary: "Добавляет штраф, зависящий от частоты появления токена в окне `--repeat-last-n`. `0.0` отключает frequency penalty."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--frequency-penalty"
allowedValues: []
env: []
related:
  - "--repeat-last-n"
  - "--repeat-penalty"
  - "--presence-penalty"
  - "--samplers"
---

# --frequency-penalty

## Кратко

`--frequency-penalty` штрафует токен сильнее, если он встречался много раз в недавней истории. Это полезно против навязчивых слов и коротких циклов, но может мешать форматам, где повторение ожидаемо.

Default: `0.00`. Значение `0.0` отключает параметр.

## Оригинальная справка llama.cpp

```text
repeat alpha frequency penalty (default: 0.00, 0.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--frequency-penalty`
- Алиасы: `--frequency-penalty`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `penalty_freq`
- HTTP-поле: `frequency_penalty`
- Значение по умолчанию: `0.00`
- CLI-парсер использует `std::stof`; отдельной проверки диапазона в `arg.cpp` нет.

## Что меняет в llama-server

CLI default записывается в `params.sampling.penalty_freq`. На уровне запроса `server-task.cpp` читает JSON-поле `frequency_penalty`.

Значение применяется в `llama_sampler_init_penalties` вместе с `--repeat-last-n`, `--repeat-penalty` и `--presence-penalty`. В default chain `penalties` стоит перед DRY и вероятностными фильтрами, поэтому frequency penalty влияет на распределение до `top_k`/`top_p`/`min_p`/`temperature`.

## Значения и формат

- `0.0`: disabled.
- Положительное число: штраф растет с количеством появлений токена в окне.
- Малые значения обычно безопаснее для production; большие значения быстро ломают повторяемые структуры.
- Отрицательные значения parser принимает, но они будут поощрять частые токены, что редко нужно для обычного сервера.

## Когда использовать

Включайте `--frequency-penalty`, если модель не просто возвращается к теме, а многократно использует одно и то же слово, маркер списка или короткую фразу. Для единичного "не повторять уже сказанное" чаще подходит `--presence-penalty`.

Для constrained generation, JSON и кода сначала проверьте на реальных схемах: структурные токены могут быть частыми по необходимости.

## Влияние на производительность и память

Параметр не влияет на RAM, VRAM и KV-cache. Дополнительная работа относится к CPU sampling и зависит от `--repeat-last-n` и числа активных генераций.

## Взаимодействие с другими аргументами

- `--repeat-last-n`: задает окно подсчета частот; `0` отключает эффект.
- `--presence-penalty`: штрафует сам факт присутствия токена; вместе с `--frequency-penalty` усиливает запрет.
- `--repeat-penalty`: еще один штраф в том же `penalties` sampler.
- `--samplers`: должен содержать `penalties`.
- `--mirostat`: при `--mirostat 1/2` default chain с `penalties` не используется.

## INI-пресеты и router-режим

Аргумент является sampling option и может находиться в `--models-preset`:

```ini
[model.default]
frequency-penalty = 0.2
```

JSON-поле `frequency_penalty` в запросе переопределяет preset/default только для этой задачи.

## Типовые проблемы и диагностика

- Модель избегает нужных повторов в списках: снижайте `--frequency-penalty` или уменьшайте `--repeat-last-n`.
- Штраф не работает: проверьте `--samplers`, `--mirostat` и `repeat_last_n` в фактических task params.
- Поведение меняется от клиента к клиенту: проверьте, отправляет ли клиент OpenAI-compatible `frequency_penalty`.

В trace/debug логах смотрите строку `sampler params` и значение `frequency_penalty`.

## Примеры

```bash
llama-server --model /models/model.gguf --repeat-last-n 256 --frequency-penalty 0.2
```

```json
{
  "prompt": "Напиши разнообразный список вариантов",
  "frequency_penalty": 0.25,
  "repeat_last_n": 256
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--frequency-penalty`.
- `llama.cpp/common/common.h`: default `penalty_freq = 0.00f`.
- `llama.cpp/common/sampling.cpp`: `llama_sampler_init_penalties`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `frequency_penalty`.
- `llama.cpp/tools/server/README.md`: CLI help и request docs.
