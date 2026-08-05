---
schema: 1
primaryName: "--mirostat-ent"
title: "--mirostat-ent"
summary: "Задает целевую энтропию Mirostat, параметр `tau`. Используется только в режимах `--mirostat 1` и `--mirostat 2`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--mirostat-ent"
allowedValues: []
env: []
related:
  - "--mirostat"
  - "--mirostat-lr"
  - "--temp"
---

# --mirostat-ent

## Кратко

`--mirostat-ent` задает целевую энтропию Mirostat. В коде llama.cpp этот параметр называется `mirostat_tau`, а в server JSON поле называется `mirostat_tau`.

Default: `5.00`.

## Оригинальная справка llama.cpp

```text
Mirostat target entropy, parameter tau (default: 5.00)
```

## Паспорт аргумента

- Основное имя: `--mirostat-ent`
- Алиасы: `--mirostat-ent`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `mirostat_tau`
- HTTP-поле: `mirostat_tau`
- Значение по умолчанию: `5.00`
- CLI-парсер использует `std::stof`; отдельной проверки диапазона в `arg.cpp` нет.

## Что меняет в llama-server

Значение передается как `tau` в Mirostat v1 и v2 samplers. При `--mirostat 0` оно не используется обычной sampler chain, хотя остается в task params и логах.

Более высокий target entropy обычно допускает более разнообразные продолжения; более низкий делает выбор токенов более консервативным.

## Значения и формат

- `5.00`: default.
- Меньше default: более предсказуемая генерация.
- Больше default: больше разнообразия, выше риск ухода в шум.
- Некорректная float-строка приведет к ошибке разбора.

## Когда использовать

Настраивайте `--mirostat-ent` после выбора версии Mirostat. Если текст слишком однообразный, повышайте `tau` небольшими шагами. Если текст становится хаотичным, снижайте `tau` или вернитесь к обычной sampler chain.

## Влияние на производительность и память

RAM, VRAM и KV-cache не меняются. Параметр меняет только критерий выбора токена в CPU-side Mirostat sampler.

## Взаимодействие с другими аргументами

- `--mirostat`: должен быть `1` или `2`.
- `--mirostat-lr`: определяет скорость адаптации к `tau`.
- `--temp`: применяется перед Mirostat sampler.
- `--top-p`, `--top-k`, `--repeat-penalty`, `--dry-*`: при `mirostat != 0` default chain с этими samplers не используется.

## INI-пресеты и router-режим

Аргумент разрешен в `--models-preset`:

```ini
[model.experimental]
mirostat = 2
mirostat-ent = 4.5
```

В JSON request используйте `mirostat_tau`.

## Типовые проблемы и диагностика

- Параметр не влияет: `mirostat` равен `0`.
- Клиент отправляет `mirostat_ent`: сервер ожидает `mirostat_tau`.
- Текст стал слишком случайным: снизьте `--mirostat-ent` или используйте обычный `--temp`/`--top-p` режим.

## Примеры

```bash
llama-server --model /models/model.gguf --mirostat 2 --mirostat-ent 4.5 --mirostat-lr 0.1
```

```json
{
  "prompt": "Продолжи текст",
  "mirostat": 2,
  "mirostat_tau": 4.5,
  "mirostat_eta": 0.1
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--mirostat-ent`.
- `llama.cpp/common/common.h`: default `mirostat_tau = 5.00f`.
- `llama.cpp/common/sampling.cpp`: передача `mirostat_tau` в Mirostat samplers.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поле `mirostat_tau`.
- `llama.cpp/tools/server/README.md`: описание `mirostat_tau`.
