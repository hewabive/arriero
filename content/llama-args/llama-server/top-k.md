---
schema: 1
primaryName: "--top-k"
title: "--top-k"
summary: "Ограничивает кандидатов K самыми вероятными токенами до последующих sampler-фильтров. `0` и отрицательные значения отключают фильтр; значение может быть переопределено HTTP-полем `top_k`."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--top-k"
allowedValues: []
env:
  - "LLAMA_ARG_TOP_K"
related:
  - "--top-p"
  - "--min-p"
  - "--samplers"
  - "--backend-sampling"
---

# --top-k

## Кратко

`--top-k` оставляет в распределении только `K` токенов с наибольшими logits. Это ранний ограничитель ширины выбора: чем меньше `K`, тем меньше неожиданных токенов пройдет дальше в `top_p`, `min_p`, `xtc` и `temperature`.

## Оригинальная справка llama.cpp

```text
top-k sampling (default: 40, 0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--top-k`
- Поле в `common_params`: `params.sampling.top_k`
- HTTP-поле: `top_k`
- Env: `LLAMA_ARG_TOP_K`
- Значение по умолчанию: `40`
- Отключение: `0` или любое значение `<= 0`

## Что меняет в llama-server

CLI-парсер записывает целое число в `params.sampling.top_k` и помечает параметр как явно заданный пользователем. Поэтому metadata модели `general.sampling.top_k` не заменит CLI-значение.

Фильтр применяется только если sampler-цепочка содержит `top_k` (`--samplers`) или букву `k` (`--sampler-seq`). В стандартной цепочке `top_k` идет после penalties, DRY и `top_n_sigma`, но перед `typ_p`, `top_p`, `min_p`, `xtc` и `temperature`.

## Значения и формат

- `40` - дефолт.
- `1` - оставляет только самый вероятный токен до финального sampling; практически жадный режим, даже если температура высокая.
- `0` - отключает top-k.
- `< 0` - низкоуровневый sampler тоже считает отключением, хотя help документирует только `0`.
- `> vocab size` - фактически не сужает распределение сильнее словаря.

В HTTP-запросе используется JSON-поле `top_k`, например `"top_k": 20`.

## Когда использовать

- Уменьшайте `top_k`, если модель часто выбирает редкие мусорные токены или нестабильна при высокой температуре.
- Увеличивайте или отключайте, если ответы слишком однообразные и уже ограничены `top_p`/`min_p`.
- Для benchmark-сценариев фиксируйте `--top-k` вместе с `--seed`; иначе даже одинаковая температура может давать разные профили выбора.

## Влияние на производительность и память

Память модели и KV-cache не меняются. На CPU top-k сортирует/частично сортирует кандидатов и обычно дешевле forward pass. Малый `K` может немного уменьшить стоимость последующих sampler-фильтров, потому что дальше проходит меньше кандидатов.

Backend sampling имеет реализацию `top_k`; при `--backend-sampling` этот фильтр может выполняться на backend-е, если цепочка не содержит несовместимых sampler-ов.

## Взаимодействие с другими аргументами

- `--samplers` или `--sampler-seq` должны включать `top_k`/`k`, иначе значение хранится, но фильтр не применяется.
- `--top-p` и `--min-p` работают уже на результате `top_k` в стандартном порядке.
- `--mirostat 1` или `--mirostat 2` отключают обычную sampler-цепочку; `top_k` в этом режиме не используется.
- `--backend-sampling` поддерживает top-k, но весь режим может отключиться для запроса при speculative decoding или pre-sampling logprobs.

## INI-пресеты и router-режим

`--top-k` является sampling option и допускается в `--models-preset`. Ключ INI:

```ini
[strict]
top-k = 20
```

В router-режиме preset модели может задать `top-k`, а запрос к child server может заменить его через `"top_k"`.

## Типовые проблемы и диагностика

- Высокая температура не дает разнообразия: проверьте, не стоит ли `--top-k 1` или маленький `top_k` в HTTP-запросе.
- Значение из GGUF metadata не применяется: CLI/env `--top-k` или `LLAMA_ARG_TOP_K` имеют приоритет.
- В trace-логах `sampler chain` должен содержать `top-k` или `?top-k`; `?top-k` означает пустой sampler, обычно из-за `top_k <= 0`.

## Примеры

```bash
llama-server --model /models/model.gguf --top-k 20
```

```bash
LLAMA_ARG_TOP_K=0 llama-server --model /models/model.gguf
```

```bash
llama-server --model /models/model.gguf --top-k 1 --temp 0.8
```

## Источники

- `llama.cpp/common/arg.cpp` - объявление `--top-k`, env и user sampling bit.
- `llama.cpp/common/common.h` - дефолт `top_k = 40`.
- `llama.cpp/common/common.cpp` - чтение `general.sampling.top_k`.
- `llama.cpp/common/sampling.cpp` - место `top_k` в цепочке.
- `llama.cpp/src/llama-sampler.cpp` - `llama_sampler_init_top_k`, `k <= 0` как empty sampler.
- `llama.cpp/tools/server/server-task.cpp` - HTTP-поле `top_k`.
