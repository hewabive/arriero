---
schema: 1
primaryName: "--mirostat-lr"
title: "--mirostat-lr"
summary: "Задает learning rate Mirostat, параметр `eta`. Используется только когда `--mirostat` равен `1` или `2`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--mirostat-lr"
allowedValues: []
env: []
related:
  - "--mirostat"
  - "--mirostat-ent"
  - "--temp"
---

# --mirostat-lr

## Кратко

`--mirostat-lr` задает скорость адаптации Mirostat к целевой энтропии. В коде llama.cpp этот параметр называется `mirostat_eta`.

Default: `0.10`.

## Оригинальная справка llama.cpp

```text
Mirostat learning rate, parameter eta (default: 0.10)
```

## Паспорт аргумента

- Основное имя: `--mirostat-lr`
- Алиасы: `--mirostat-lr`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `mirostat_eta`
- HTTP-поле: `mirostat_eta`
- Значение по умолчанию: `0.10`
- CLI-парсер использует `std::stof`; отдельной проверки диапазона в `arg.cpp` нет.

## Что меняет в llama-server

Значение передается как `eta` в `llama_sampler_init_mirostat` для `--mirostat 1` и в `llama_sampler_init_mirostat_v2` для `--mirostat 2`.

При `--mirostat 0` параметр хранится в sampling params и печатается в логах, но не используется в обычной sampler chain.

## Значения и формат

- `0.10`: default.
- Меньше значение: более медленная и стабильная адаптация.
- Больше значение: более быстрая, но потенциально более дерганая адаптация.
- Некорректный float завершит разбор CLI ошибкой преобразования.

## Когда использовать

Меняйте `--mirostat-lr`, если включенный Mirostat слишком медленно выходит из скучного или хаотичного режима, либо наоборот слишком резко меняет стиль генерации. Обычно `--mirostat-ent` выбирают как цель, а `--mirostat-lr` корректируют как скорость движения к ней.

## Влияние на производительность и память

Память не меняется. На latency влияет только косвенно через режим sampling; само значение `eta` не меняет размер контекста и KV-cache.

## Взаимодействие с другими аргументами

- `--mirostat`: должен быть `1` или `2`, иначе `--mirostat-lr` не участвует в выборе токена.
- `--mirostat-ent`: целевая энтропия `tau`, к которой адаптируется Mirostat.
- `--temp`: применяется перед Mirostat sampler.

## INI-пресеты и router-режим

Аргумент разрешен в `--models-preset`:

```ini
[model.experimental]
mirostat = 2
mirostat-lr = 0.05
```

В JSON request используйте имя поля `mirostat_eta`.

## Типовые проблемы и диагностика

- Изменение не влияет: проверьте, что `mirostat` не равен `0`.
- Генерация стала нестабильной: уменьшите `--mirostat-lr`.
- В OpenAI-compatible клиенте поле называется не как CLI: нужен `mirostat_eta`, а не `mirostat_lr`.

## Примеры

```bash
llama-server --model /models/model.gguf --mirostat 2 --mirostat-lr 0.05
```

```json
{
  "prompt": "Продолжи текст",
  "mirostat": 2,
  "mirostat_eta": 0.05
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--mirostat-lr`.
- `llama.cpp/common/common.h`: default `mirostat_eta = 0.10f`.
- `llama.cpp/common/sampling.cpp`: передача `mirostat_eta` в Mirostat samplers.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `mirostat_eta`.
- `llama.cpp/tools/server/README.md`: описание `mirostat_eta`.
