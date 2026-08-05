---
schema: 1
primaryName: "--top-p"
title: "--top-p"
summary: "Включает nucleus sampling: оставляет минимальный набор самых вероятных токенов с суммарной вероятностью не ниже P. `1.0` и выше отключают фильтр; HTTP-запрос может заменить дефолт полем `top_p`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--top-p"
allowedValues: []
env: []
related:
  - "--top-k"
  - "--min-p"
  - "--typical"
  - "--samplers"
---

# --top-p

## Кратко

`--top-p` задает nucleus sampling. Фильтр сортирует кандидатов по вероятности и оставляет верхнюю часть распределения, пока накопленная вероятность не достигнет `P`.

## Оригинальная справка llama.cpp

```text
top-p sampling (default: 0.95, 1.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--top-p`
- Поле в `common_params`: `params.sampling.top_p`
- HTTP-поле: `top_p`
- Значение по умолчанию: `0.95`
- Отключение: `1.0` или больше
- Этап применения: sampler `top_p` в цепочке генерации.

## Что меняет в llama-server

CLI-парсер читает float через `std::stof`, записывает его в `params.sampling.top_p` и выставляет user sampling bit. Если GGUF содержит `general.sampling.top_p`, оно применяется только когда пользователь не задал `--top-p`.

В стандартной цепочке `top_p` идет после `top_k` и `typ_p`, но перед `min_p`, `xtc` и `temperature`. На каждый HTTP-запрос `server-task.cpp` может заменить значение полем `top_p`.

## Значения и формат

- `0.95` - дефолт.
- `0.8`-`0.95` - типичный рабочий диапазон.
- `1.0` - отключено.
- `> 1.0` - также фактически отключено.
- Очень низкие значения резко сужают выбор и могут делать текст шаблонным.

Если `min_keep` задан через HTTP, top-p обязан оставить как минимум это число кандидатов.

## Когда использовать

- Снижайте `top_p`, если модель уходит в слишком редкие варианты при высокой температуре.
- Поднимайте к `1.0`, если уже используете `min_p` или хотите сохранить больше хвоста распределения.
- Для строгих задач обычно лучше менять `--temp` и `--top-p` вместе, а не только один параметр.

## Влияние на производительность и память

Память не меняется. Фильтр требует softmax и сортировку/частичную сортировку кандидатов, но обычно это небольшая часть latency относительно вычисления модели. Чем шире распределение и чем больше словарь, тем заметнее стоимость.

Backend sampling содержит реализацию top-p, но режим может быть отключен для запроса, если включены grammar/reasoning budget/speculative или pre-sampling logprobs.

## Взаимодействие с другими аргументами

- `--top-k` сначала может ограничить кандидатов, доступных для `top_p`.
- `--min-p` применяется после `top_p` в стандартном порядке и может дополнительно отсечь слабые токены.
- `--samplers` должен содержать `top_p`, а `--sampler-seq` - `p`.
- `--mirostat` игнорирует обычную цепочку top-k/top-p/typical.
- `--temp` масштабирует logits после top-p в стандартной цепочке.

## INI-пресеты и router-режим

Ключ для `--models-preset`:

```ini
[balanced]
top-p = 0.9
```

Sampling options разрешены в router presets. Запросы к модели могут переопределять значение через `"top_p"`.

## Типовые проблемы и диагностика

- `--top-p` не влияет на ответы: проверьте, есть ли `top_p`/`p` в sampler-цепочке и не включен ли `--mirostat`.
- Модель стала слишком однообразной: возможно, одновременно низкие `--top-k`, `--top-p`, `--min-p` и `--temp`.
- В trace-логах `sampler chain` должен содержать `top-p` или `?top-p`; `?top-p` означает отключение при `p >= 1.0`.

## Примеры

```bash
llama-server --model /models/model.gguf --top-p 0.9
```

```bash
llama-server --model /models/model.gguf --top-k 0 --top-p 0.95 --temp 0.8
```

```bash
llama-server --model /models/model.gguf --top-p 1.0
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--top-p`.
- `llama.cpp/common/common.h` - дефолт `top_p = 0.95f`.
- `llama.cpp/common/common.cpp` - metadata `general.sampling.top_p`.
- `llama.cpp/common/sampling.cpp` - порядок sampler-цепочки.
- `llama.cpp/src/llama-sampler.cpp` - реализация `llama_sampler_init_top_p`.
- `llama.cpp/tools/server/server-task.cpp` - HTTP-поле `top_p`.
