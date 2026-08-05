---
schema: 1
primaryName: "--temp"
title: "--temp"
summary: "Базовая температура sampling-цепочки: снижает или повышает случайность выбора следующего токена. Значение применяется как дефолт сервера и может быть переопределено в HTTP-запросе полем `temperature`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--temp"
  - "--temperature"
allowedValues: []
env: []
related:
  - "--dynatemp-range"
  - "--dynatemp-exp"
  - "--samplers"
  - "--seed"
---

# --temp

## Кратко

`--temp` задает температуру распределения токенов в sampler-цепочке. Меньшие значения делают выбор более жадным и повторяемым, большие значения сильнее выравнивают вероятности и повышают разнообразие.

В `llama-server` это стартовый дефолт. Клиент может переопределить его на один запрос JSON-полем `temperature`.

## Оригинальная справка llama.cpp

```text
temperature (default: 0.80)
```

## Паспорт аргумента

- Основное имя: `--temp`
- Алиасы: `--temp`, `--temperature`
- Поле в `common_params`: `params.sampling.temp`
- HTTP-поле: `temperature`
- Значение по умолчанию: `0.80`
- Этап применения: CLI-парсинг задает дефолт сервера; при генерации sampler `temperature` масштабирует logits.

## Что меняет в llama-server

CLI-парсер читает число через `std::stof`, записывает его в `params.sampling.temp` и принудительно поднимает отрицательные CLI-значения до `0.0`. Для `--temp` выставляется бит пользовательской sampling-конфигурации, поэтому metadata модели `general.sampling.temperature` не перезаписывает явно заданное CLI-значение.

В sampler-цепочке температура применяется элементом `temperature` из `--samplers` или буквой `t` из `--sampler-seq`. В стандартной цепочке этот элемент стоит в конце фильтров: `penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature`, после чего llama.cpp добавляет финальный sampler выбора токена (`dist`) либо `adaptive_p`, если он явно включен.

Если `--mirostat 1` или `--mirostat 2`, обычная цепочка `--samplers` не используется: llama.cpp добавляет только температурный sampler и соответствующий Mirostat sampler. В этом режиме `--temp` все равно участвует.

## Значения и формат

- `0.8` - дефолт llama.cpp для сервера.
- `0` - жадный режим на уровне температурного sampler-а: остается только токен с максимальным logit.
- `1` - нейтральная температура, если `--dynatemp-range 0`; такой sampler становится пустым (`?temp-ext`) и не меняет logits.
- `> 1` - более случайный выбор.
- `< 0` в CLI фактически превращается в `0`; в HTTP-поле `temperature` такой clamp в `server-task.cpp` не выполняется, но низкоуровневый sampler трактует `temp <= 0` как greedy.

Для динамической температуры `--temp` становится центром диапазона: фактическое значение выбирается в `[max(0, temp - dynatemp_range), temp + dynatemp_range]`.

## Когда использовать

- Снижайте до `0`-`0.3`, когда нужны стабильные ответы, воспроизводимые тесты или извлечение фактов.
- Оставляйте около `0.7`-`0.9` для обычного диалога и ассистентских задач.
- Поднимайте выше `1`, когда важны варианты формулировок, brainstorming или творческая генерация.

При сравнении моделей фиксируйте одновременно `--seed`, `--samplers`, `--top-k`, `--top-p`, `--min-p` и penalties, иначе изменение температуры трудно изолировать.

## Влияние на производительность и память

Память модели, KV-cache и VRAM не меняются. CPU/GPU стоимость мала по сравнению с forward pass, но температура влияет на форму распределения и поэтому на итоговый текст, частоту раннего EOS и длину генерации.

При `--backend-sampling` температурный sampler может выполняться backend-ом, если вся активная цепочка совместима и сервер не отключил backend sampling для конкретного запроса.

## Взаимодействие с другими аргументами

- `--dynatemp-range` и `--dynatemp-exp` расширяют `--temp` до динамической температуры.
- `--samplers` должен содержать `temperature`, иначе `--temp` не участвует в обычной цепочке.
- `--sampler-seq` должен содержать `t`, иначе `--temp` не участвует в обычной цепочке.
- `--mirostat` игнорирует обычные top-k/top-p/typical-фильтры, но оставляет температуру перед Mirostat.
- `--seed` влияет на случайный выбор после температурного масштабирования, но сам `--temp` не делает запуск воспроизводимым.

## INI-пресеты и router-режим

Параметр помечен как sampling option, поэтому разрешен в `--models-preset`, включая remote presets из whitelist-логики. В INI используется ключ без дефисов:

```ini
[creative]
temp = 1.05
```

В router-режиме дочерние процессы наследуют CLI/env router-а, а preset модели может задать собственный `temp`. HTTP-запрос к конкретной модели все равно может переопределить значение через `temperature`.

## Типовые проблемы и диагностика

- Ответы одинаковые при `--temp 1`: проверьте `--seed`, `--top-k`, `--top-p`, `--min-p`, penalties и наличие `temperature`/`t` в цепочке.
- `--temp` будто не работает: запрос мог передать поле `temperature`, которое перекрывает дефолт сервера.
- Слишком ранний EOS: высокая температура и широкие фильтры могут чаще выбирать EOG/EOS; проверяйте `--ignore-eos`, stop-строки и `max_tokens`.
- Диагностика в trace-логах: `sampler chain` должен содержать `temp-ext` или `?temp-ext`, а `sampler params` печатает `temp = ...`.

## Примеры

```bash
llama-server --model /models/model.gguf --temp 0
```

```bash
llama-server --model /models/model.gguf --temp 0.7 --top-p 0.9 --seed 42
```

```bash
llama-server --model /models/model.gguf --temp 0.8 --dynatemp-range 0.2 --dynatemp-exp 1.0
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--temp`, clamp CLI-значения и user sampling bit.
- `llama.cpp/common/common.h` - дефолт `common_params_sampling::temp = 0.80f`.
- `llama.cpp/common/common.cpp` - чтение `general.sampling.temperature` из metadata модели.
- `llama.cpp/common/sampling.cpp` - построение sampler-цепочки.
- `llama.cpp/src/llama-sampler.cpp` - реализация `llama_sampler_init_temp_ext` и greedy-ветка `temp <= 0`.
- `llama.cpp/tools/server/server-task.cpp` - HTTP-поле `temperature`.
