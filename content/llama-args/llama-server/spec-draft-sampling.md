---
schema: 1
primaryName: "--spec-draft-sampling"
title: "--spec-draft-sampling"
summary: "Выбирает, как `draft-simple` и `draft-mtp` строят draft: `greedy` (по умолчанию) берет argmax, `probabilistic` сэмплирует draft при temperature запроса, а target проверяет его rejection sampling. Действует только на запросы с temperature больше нуля."
category: "Параметры speculative decoding"
valueType: "enum"
estimation: "normal"
valueHint: "{greedy,probabilistic}"
aliases:
  - "--spec-draft-sampling"
allowedValues:
  - "greedy"
  - "probabilistic"
env:
  - "LLAMA_ARG_SPEC_DRAFT_SAMPLING"
related:
  - "--spec-type"
  - "--spec-draft-model"
  - "--spec-draft-p-min"
  - "--spec-draft-n-max"
  - "--spec-draft-backend-sampling"
  - "--temp"
  - "--seed"
---

# --spec-draft-sampling

## Кратко

`--spec-draft-sampling` задает `common_params.speculative.draft.probabilistic`.

- `greedy` (по умолчанию): draft-модель или MTP-голова предлагает свой argmax-токен, target сэмплирует сам и принимает draft, пока его токены совпадают с draft (sample-and-match).
- `probabilistic`: draft сэмплирует токен из своего распределения q при temperature запроса, target принимает каждый draft-токен с вероятностью `min(1, p/q)`, а при отказе выбирает замену из нормированного остатка `max(0, p - q)` — классический rejection sampling.

Оба режима сохраняют распределение target-модели; различаются acceptance и, как следствие, скорость. Режим влияет только на `draft-simple` и `draft-mtp` и только на запросы с `temperature > 0`.

## Оригинальная справка llama.cpp

```text
how the draft is sampled: greedy takes its argmax, probabilistic samples it and has the target verify by rejection sampling (default: greedy)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-sampling`
- Алиасов нет
- Допустимые значения: `greedy`, `probabilistic`
- Структура llama.cpp: `common_params.speculative.draft.probabilistic` (`false` соответствует `greedy`)
- Переменная окружения: `LLAMA_ARG_SPEC_DRAFT_SAMPLING`
- Значение по умолчанию: `greedy`
- Этап применения: каждый раунд drafting и verification в `server-context.cpp`; per-request переопределения нет

## Что меняет в llama-server

Решение принимается на каждом раунде для каждого слота. Сервер передает drafter-у буфер для candidate-распределений (`result_q`), temperature и seed запроса, только если `temperature` запроса больше нуля (`use_spec_rejection()`). При `temperature <= 0` p и q вырождаются в один токен, rejection совпадает с match, и сервер идет обычным путем независимо от флага.

В `draft-simple` и `draft-mtp`:

- `greedy`: буфер candidates отключается, draft sampler (`top_k(10)`) сбрасывается каждый раунд, в draft идет `cur_p->data[0]` — argmax среди top-10.
- `probabilistic`: draft sampler слота пересобирается (`spec_retune`) как `top_k(10)` + `temperature` с temperature запроса и seed запроса, смешанным с константой, чтобы поток случайных чисел не совпадал с target. Другие sampling-параметры запроса (`top_p`, `min_p`, penalties, grammar) в draft не переносятся. В draft идет сэмплированный токен, а для каждого draft-токена сохраняется его распределение q по top-10 candidates. Sampler сбрасывается в начале запроса, а не каждый раунд, поэтому два одинаковых запроса с одинаковым `seed` дают одинаковый результат.

Verification. Если у слота есть q-распределения, вызывается `common_sampler_sample_and_accept_n_rejection()`: target sampler проходит свою полную цепочку на позиции, его candidates дают p; draft-токен принимается при `p >= q` либо с вероятностью `p/q` по отдельному RNG target sampler-а. При отказе замена выбирается из остатка `max(0, p - q)` (токены вне top-10 draft сохраняют весь свой p), и раунд заканчивается. Если приняты все draft-токены, target сэмплирует еще один токен, как и в greedy-режиме. Без q-распределений используется прежний `common_sampler_sample_and_accept_n()`.

Grammar. Для запросов с grammar или JSON schema rejection идет по p, маскированному grammar и перенормированному: запрещенный grammar draft-токен получает `p = 0` и отклоняется, замена выбирается только из допустимых токенов. Сам draft sampler grammar не применяет.

Checkpoint replay. Если target-контекст не умеет частично удалять последовательность и сервер восстанавливает speculative checkpoint, уже принятые токены повторно принимаются через `server_accept_replay()` без новой проверки.

## Значения и формат

- `greedy` — draft = argmax, verification sample-and-match. Значение по умолчанию.
- `probabilistic` — draft сэмплируется при temperature запроса, verification rejection sampling.
- Другое значение: `invalid value, must be one of: greedy, probabilistic`.

## Когда использовать

`probabilistic` рассчитан на генерацию с ненулевой temperature, где argmax draft часто расходится с токеном, который сэмплирует target. Ожидаемая доля принятия на позицию — `Σ min(p, q)` вместо `p(argmax q)` у greedy, поэтому при близких распределениях draft и target acceptance растет. Дефолтный `--temp` равен `0.80`, так что без явного `temperature` в запросе rejection-путь активен.

Выигрыш не гарантирован. Draft использует только `top_k(10)` и temperature, а target может дополнительно сужать распределение `top_p`, `min_p` и penalties; если p заметно острее q, greedy-режим может принимать больше. Сравнивайте `draft acceptance` и token/s на своем workload.

Для запросов с `temperature = 0` (детерминированная генерация, tool calling) режим ничего не меняет.

## Влияние на производительность и память

Память практически не меняется: на слот хранится до `n_max` векторов по 10 candidates. CPU-стоимость — пересборка draft sampler-а при смене temperature или seed между запросами и поиск по candidates при verification; это мало по сравнению с forward pass.

`--spec-draft-p-min` в `probabilistic` сравнивается с вероятностью top-кандидата после temperature запроса (нормированной в top-10). При высокой temperature распределение площе, и тот же порог обрывает draft раньше; в `greedy` вероятность считается без temperature.

## Взаимодействие с другими аргументами

- `--spec-type`: режим работает для `draft-simple` и `draft-mtp`. `draft-eagle3`, `draft-dflash`, `draft-dspark` и n-gram типы q не заполняют и всегда проверяются sample-and-match. В смешанном списке (например `ngram-mod,draft-mtp`) способ проверки зависит от того, какая реализация дала draft в этом раунде.
- `--spec-draft-p-min`: порог проверяется по top-кандидату, а не по сэмплированному токену; см. выше про temperature.
- `--spec-draft-backend-sampling`: для MTP backend chain выполняет только `top_k(10)`, temperature и случайный выбор делает CPU sampler на этих candidates, так что флаги совместимы.
- `--temp` и поле `temperature` запроса включают rejection (`> 0`) и задают temperature draft sampler-а.
- `--seed` и поле `seed` запроса детерминируют draft sampler и RNG rejection; при случайном seed по умолчанию draft тоже случайный.
- `--spec-draft-n-max`: если draft обрезается до лимита слота, candidates обрезаются вместе с ним.
- `--spec-synth-len` / `--spec-synth-rates`: synthetic acceptance заменяет verification целиком, и режим не используется.

## INI-пресеты и router-режим

```ini
[coder]
model = /models/target.gguf
model-draft = /models/draft.gguf
spec-type = draft-simple
spec-draft-sampling = probabilistic
```

В router mode задавайте per-model рядом с остальными speculative-параметрами. Без `draft-simple` или `draft-mtp` в `spec-type` значение ни на что не влияет.

## Типовые проблемы и диагностика

- `invalid value, must be one of: greedy, probabilistic`: опечатка в значении.
- Нет разницы с `greedy`: запросы идут с `temperature = 0`, draft дает n-gram/EAGLE-3/DFlash/DSpark реализация, или включена synthetic acceptance.
- Acceptance упала после переключения: target сужает распределение `top_p`/`min_p` сильнее, чем draft; верните `greedy` или сравните на нескольких temperature.
- Draft стал короче при высокой temperature: срабатывает `--spec-draft-p-min` на более плоском распределении; понизьте порог.
- Для сравнения смотрите `draft acceptance = ...` в логе завершения слота и `accepted X/Y draft tokens` при trace-логировании.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-type draft-simple --spec-draft-sampling probabilistic
```

```bash
LLAMA_ARG_SPEC_DRAFT_SAMPLING=probabilistic llama-server --model /models/target-with-mtp.gguf --spec-type draft-mtp
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/27694
- https://github.com/ggml-org/llama.cpp/pull/29924
