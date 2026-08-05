---
schema: 1
primaryName: "--top-nsigma"
title: "--top-nsigma"
summary: "Фильтр по расстоянию logits от лучшего токена: отсекает кандидатов ниже `max_logit - N * std`. По умолчанию отключен; в HTTP API соответствует полю `top_n_sigma`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--top-nsigma"
  - "--top-n-sigma"
allowedValues: []
env: []
related:
  - "--top-k"
  - "--samplers"
  - "--sampler-seq"
---

# --top-nsigma

## Кратко

`--top-nsigma` оставляет токены, logits которых находятся не ниже `N` стандартных отклонений от максимального logit. Это фильтр формы распределения, а не прямой порог вероятности.

## Оригинальная справка llama.cpp

```text
top-n-sigma sampling (default: -1.00, -1.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--top-nsigma`
- Алиас: `--top-n-sigma`
- Поле в `common_params`: `params.sampling.top_n_sigma`
- HTTP-поле: `top_n_sigma`
- Значение по умолчанию: `-1.00`
- Отключение: любое `N <= 0` в реализации sampler-а.

## Что меняет в llama-server

CLI-парсер записывает float в `params.sampling.top_n_sigma`. Отдельного user sampling bit для этого параметра нет, но текущая функция загрузки metadata модели не читает `top_n_sigma`, поэтому metadata его не меняет.

В стандартной цепочке `top_n_sigma` стоит после `dry` и перед `top_k`. Он маскирует слабые logits значением `-INFINITY`, затем пересчитывает softmax.

## Значения и формат

- `-1` - дефолт и отключение.
- `0` - тоже отключение в коде.
- `1`-`3` - практический диапазон для экспериментов; чем меньше число, тем жестче отсечка.
- Слишком малые положительные значения могут оставить очень мало кандидатов.

## Когда использовать

- Для экспериментов с более статистическим отсечением хвоста перед `top_k`.
- Когда фиксированный `top_k` плохо переносится между моделями с разной формой logits.
- Не включайте одновременно много жестких фильтров без контрольных запросов: `top_n_sigma`, маленький `top_k`, низкий `top_p` и высокий `min_p` быстро сужают выбор.

## Влияние на производительность и память

Память не меняется. Sampler проходит по кандидатам для среднего и стандартного отклонения, затем применяет маску. Backend hooks для `top_n_sigma` в текущей реализации нет, поэтому при `--backend-sampling` наличие этого активного sampler-а ограничивает выгоду backend sampling.

## Взаимодействие с другими аргументами

- В стандартном порядке срабатывает до `--top-k`, поэтому может изменить набор токенов, из которого top-k выбирает лучшие.
- `--samplers` должен содержать `top_n_sigma`, `--sampler-seq` - букву `s`.
- `--mirostat` отключает обычную цепочку и не использует `top_nsigma`.

## INI-пресеты и router-режим

Ключ INI:

```ini
[sigma-filter]
top-nsigma = 2.0
```

Параметр относится к sampling options и может быть задан в `--models-preset`. HTTP-запрос может заменить дефолт через `"top_n_sigma"`.

## Типовые проблемы и диагностика

- Параметр не влияет: проверьте, что `top_n_sigma`/`s` присутствует в sampler-цепочке.
- Слишком короткие или однообразные ответы: уменьшено слишком много фильтров одновременно.
- В trace-логе `?top-n-sigma` означает пустой sampler из-за `N <= 0`.

## Примеры

```bash
llama-server --model /models/model.gguf --top-nsigma 2.0
```

```bash
llama-server --model /models/model.gguf --samplers "penalties;dry;top_n_sigma;top_k;top_p;min_p;temperature" --top-nsigma 1.5
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--top-nsigma`.
- `llama.cpp/common/common.h` - дефолт `top_n_sigma = -1.00f`.
- `llama.cpp/common/sampling.cpp` - порядок цепочки.
- `llama.cpp/src/llama-sampler.cpp` - расчет mean/std и маска.
- `llama.cpp/tools/server/server-task.cpp` - HTTP-поле `top_n_sigma`.
