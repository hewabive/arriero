---
schema: 1
primaryName: "--mirostat"
title: "--mirostat"
summary: "Включает Mirostat sampling: `0` выключено, `1` Mirostat, `2` Mirostat 2.0. При включении обычная sampler chain с `top_k`, `top_p`, `typ_p`, `penalties` и `dry` не используется."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--mirostat"
allowedValues: []
env: []
related:
  - "--mirostat-lr"
  - "--mirostat-ent"
  - "--temp"
  - "--samplers"
---

# --mirostat

## Кратко

`--mirostat` переключает sampling в режим Mirostat, который пытается удерживать целевую энтропию генерации. В текущем коде поддерживаются режимы `0`, `1` и `2`.

Default: `0`, Mirostat выключен.

## Оригинальная справка llama.cpp

```text
use Mirostat sampling.
Top K, Nucleus and Locally Typical samplers are ignored if used.
(default: 0, 0 = disabled, 1 = Mirostat, 2 = Mirostat 2.0)
```

## Паспорт аргумента

- Основное имя: `--mirostat`
- Алиасы: `--mirostat`
- Тип CLI-значения: целое число `N`
- Поле в `common_params_sampling`: `mirostat`
- HTTP-поле: `mirostat`
- Значение по умолчанию: `0`
- Поддерживаемые значения по help и `sampling.cpp`: `0`, `1`, `2`
- Явной CLI-проверки диапазона нет; неизвестная версия приводит к assert `unknown mirostat version` при инициализации sampler.

## Что меняет в llama-server

При `--mirostat 0` llama.cpp строит обычную цепочку `params.samplers`: `penalties`, `dry`, `top_n_sigma`, `top_k`, `typ_p`, `top_p`, `min_p`, `xtc`, `temperature`, затем `dist`.

При `--mirostat 1` цепочка меняется на `temperature` плюс `llama_sampler_init_mirostat(..., mirostat_tau, mirostat_eta, 100)`.

При `--mirostat 2` цепочка меняется на `temperature` плюс `llama_sampler_init_mirostat_v2(..., mirostat_tau, mirostat_eta)`.

`logit_bias`, grammar и reasoning budget обрабатываются отдельно от этой ветки, поэтому они могут продолжать влиять на генерацию.

## Значения и формат

- `0`: выключить Mirostat, использовать обычную sampler chain.
- `1`: включить Mirostat v1.
- `2`: включить Mirostat 2.0.
- Другие значения не используйте: код не имеет мягкого fallback и может завершить процесс assert-ом.

## Когда использовать

Mirostat имеет смысл для экспериментов с более стабильной "surprise"/энтропией длинной генерации, когда обычная комбинация `--temp`, `--top-p` и `--min-p` дает слишком резкие переходы между скучным и хаотичным текстом.

Для production endpoint с предсказуемыми форматами сначала проверьте, что отключение обычных `penalties` и DRY вам подходит. Mirostat может ухудшить контроль повторов, если вы рассчитывали на `--repeat-penalty` или `--dry-multiplier`.

## Влияние на производительность и память

KV-cache, RAM модели и VRAM не меняются. Стоимость находится в CPU-side sampling. Обычно она мала, но сравнивайте latency на той же модели, потому что при `mirostat != 0` меняется вся sampler chain.

## Взаимодействие с другими аргументами

- `--mirostat-lr`: learning rate `eta`.
- `--mirostat-ent`: target entropy `tau`.
- `--temp`: все еще применяется перед Mirostat sampler.
- `--top-k`, `--top-p`, `--typical-p`, `--min-p`, `--xtc-*`, `--top-nsigma`: не добавляются в chain при `mirostat != 0`.
- `--repeat-penalty`, `--presence-penalty`, `--frequency-penalty`, `--dry-*`: default `penalties` и `dry` тоже не добавляются при `mirostat != 0`.
- `--logit-bias` и `--grammar`: применяются вне обычной sampler chain и остаются релевантными.

## INI-пресеты и router-режим

`--mirostat` является sampling option и разрешен в `--models-preset`:

```ini
[model.experimental]
mirostat = 2
mirostat-ent = 5.0
mirostat-lr = 0.1
```

HTTP-запрос может переопределить default через поле `mirostat`.

## Типовые проблемы и диагностика

- `--top-p` и `--top-k` "не работают": при Mirostat это ожидаемо, обычные вероятностные samplers не используются.
- Повторов стало больше: Mirostat отключил default `penalties`/DRY chain; верните `--mirostat 0` или контролируйте повторы другим способом.
- Процесс падает при странном значении: используйте только `0`, `1` или `2`.

В trace/debug логах `sampler params` печатает `mirostat`, `mirostat_lr` и `mirostat_ent`.

## Примеры

```bash
llama-server --model /models/model.gguf --mirostat 2 --mirostat-ent 5.0 --mirostat-lr 0.1
```

```json
{
  "prompt": "Напиши длинный связный текст",
  "mirostat": 2,
  "mirostat_tau": 5.0,
  "mirostat_eta": 0.1
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--mirostat`.
- `llama.cpp/common/common.h`: default `mirostat = 0`.
- `llama.cpp/common/sampling.cpp`: ветки Mirostat v1/v2 и обычной sampler chain.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `mirostat`.
- `llama.cpp/tools/server/README.md`: CLI help и request docs.
