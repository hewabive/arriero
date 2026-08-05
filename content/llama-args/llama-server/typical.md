---
schema: 1
primaryName: "--typical"
title: "--typical"
summary: "Настраивает locally typical sampling (`typ_p`): фильтр оставляет токены с типичной информационной неожиданностью относительно энтропии распределения. `1.0` и выше отключают фильтр; HTTP API использует поле `typical_p`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--typical"
  - "--typical-p"
allowedValues: []
env: []
related:
  - "--top-p"
  - "--min-p"
  - "--samplers"
  - "--mirostat"
---

# --typical

## Кратко

`--typical` задает параметр `typ_p` для locally typical sampling. В отличие от `top_p`, sampler сортирует кандидатов по близости `-log(p)` к энтропии текущего распределения и оставляет набор с накопленной вероятностью около `typ_p`.

## Оригинальная справка llama.cpp

```text
locally typical sampling, parameter p (default: 1.00, 1.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--typical`
- Алиас: `--typical-p`
- Поле в `common_params`: `params.sampling.typ_p`
- HTTP-поле: `typical_p`
- Значение по умолчанию: `1.00`
- Отключение: `1.0` или больше.

## Что меняет в llama-server

CLI-парсер записывает float в `params.sampling.typ_p`. В стандартной цепочке sampler называется `typ_p`; в короткой форме `--sampler-seq` ему соответствует буква `y`.

По умолчанию значение `1.0` делает sampler пустым (`?typical`), хотя элемент `typ_p` присутствует в стандартной цепочке. Metadata модели в текущем коде не переопределяет `typ_p`.

## Значения и формат

- `1.0` - отключено.
- `0.95` - мягкое typical-сэмплирование.
- Более низкие значения сильнее отсекают нетипичные токены.
- `> 1.0` - также отключено по реализации.

## Когда использовать

- Когда `top_p` дает слишком очевидные или слишком случайные варианты, а нужна фильтрация по форме распределения.
- Для экспериментов с письмом и диалогом, где важно избегать как слишком банальных, так и слишком неожиданных токенов.
- Не включайте вместе с `--mirostat`: при Mirostat обычные top-k/nucleus/typical samplers не используются.

## Влияние на производительность и память

Память не меняется. Typical sampler считает softmax, энтропию и сортирует кандидатов по shifted score; это дороже простого порога, но обычно дешевле forward pass модели. Backend implementation для typical в текущем `llama-sampler.cpp` отсутствует.

## Взаимодействие с другими аргументами

- В стандартном порядке `typ_p` идет после `top_k` и перед `top_p`.
- `--samplers` должен содержать `typ_p`; CLI `--samplers` также принимает альтернативные имена `typical`, `typical-p`, `typ-p`, `typ`.
- `--sampler-seq` должен содержать `y`.
- `--mirostat` обходит обычную цепочку.

## INI-пресеты и router-режим

Ключ INI:

```ini
[typical]
typical = 0.95
```

Параметр разрешен в `--models-preset` как sampling option. На уровне HTTP используйте `"typical_p"`, а не `"typical"`.

## Типовые проблемы и диагностика

- Значение задано, но эффекта нет: `typical_p >= 1.0`, sampler удален из `--samplers`, или включен `--mirostat`.
- Слишком узкий выбор: проверьте комбинацию `--typical`, `--top-p`, `--min-p` и `--top-k`.
- В trace-логе `?typical` означает отключенный typical sampler.

## Примеры

```bash
llama-server --model /models/model.gguf --typical 0.95
```

```bash
llama-server --model /models/model.gguf --samplers "penalties;dry;top_k;typ_p;top_p;min_p;temperature" --typical-p 0.9
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-task.cpp`
