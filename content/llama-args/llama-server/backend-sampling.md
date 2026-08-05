---
schema: 1
primaryName: "--backend-sampling"
title: "--backend-sampling"
summary: "Экспериментально переносит совместимые sampler-операции в backend llama.cpp. Режим может автоматически отключаться для конкретного запроса при grammar, reasoning budget, speculative decoding или pre-sampling logprobs."
category: "Параметры сэмплинга"
valueType: "flag"
valueHint: null
aliases:
  - "-bs"
  - "--backend-sampling"
allowedValues: []
env:
  - "LLAMA_ARG_BACKEND_SAMPLING"
related:
  - "--samplers"
  - "--top-k"
  - "--top-p"
  - "--min-p"
  - "--temp"
---

# --backend-sampling

## Кратко

`--backend-sampling` включает экспериментальный путь, при котором sampler chain может быть передан в backend и выполняться ближе к вычислению logits. Это не гарантированное ускорение: совместимость зависит от sampler-ов и от параметров конкретного запроса.

## Оригинальная справка llama.cpp

```text
enable backend sampling (experimental) (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--backend-sampling`
- Алиас: `-bs`
- Поле в `common_params`: `params.sampling.backend_sampling`
- HTTP-поле: `backend_sampling`
- Env: `LLAMA_ARG_BACKEND_SAMPLING`
- Значение по умолчанию: disabled.

## Что меняет в llama-server

CLI-флаг ставит `params.sampling.backend_sampling = true`. При создании общего context llama.cpp заранее инициализирует sampler-ы на каждую sequence и, если режим включен, передает их в `llama_context_params`.

В server runtime sampler заново создается на слот. Затем server решает, можно ли вызвать `llama_set_sampler(ctx, slot.id, sampler)`. Режим отключается для запроса, если:

- `task.params.sampling.backend_sampling` false;
- слот использует speculative decoding;
- нужны pre-sampling logits (`n_probs > 0` и `post_sampling_probs == false`);
- sampler init выключил backend sampling из-за grammar или reasoning budget.

## Совместимость sampler-ов

В текущем `llama-sampler.cpp` backend hooks есть у `top_k`, `top_p`, `min_p`, `temp_ext` и `dist`. Не все sampler-ы имеют backend implementation: typical, XTC, top-n-sigma, adaptive-p, penalties/DRY и grammar-related sampler-ы требуют CPU-side логики или отключают режим.

Фактическую совместимость проверяйте trace-логами и тестами на вашей сборке backend-а.

## Когда использовать

- Для экспериментов с latency/throughput на backend-ах, где sampling становится заметным bottleneck.
- Для цепочек, близких к `top_k;top_p;min_p;temperature`.
- Не включайте без контрольного сравнения качества и скорости: флаг помечен как experimental.

## Влияние на производительность и память

Модель и KV-cache не меняются, но output buffer увеличивается не только на маленькие sampler configs. Для каждого зарезервированного output llama.cpp добавляет две F32 строки длиной `n_vocab` (logits + probabilities), один массив token candidates длиной `n_vocab` и один sampled token. Стартовая добавка при server slots равна `(3 * n_vocab + 1) * n_parallel * 4` bytes; при request-time росте числа outputs buffer может быть увеличен повторно.

На stories15M, ctx/batch/ubatch 128 и одном slot, b10276 увеличил host output buffer с 0.12 до 0.49 MiB. Arriero включает стартовую постоянную добавку; последующее увеличение остается динамическим.

## Взаимодействие с другими аргументами

- `--samplers` определяет, есть ли в цепочке backend-compatible sampler-ы.
- Grammar/JSON schema и reasoning budget отключают backend sampling warning-ом.
- `n_probs` без `post_sampling_probs` отключает backend sampling для запроса.
- Speculative decoding сейчас несовместим с backend sampling в server-context.

## INI-пресеты и router-режим

Ключ INI для флага:

```ini
[backend-sampling]
backend-sampling = true
```

Параметр является sampling option, поэтому допускается в presets. Env `LLAMA_ARG_BACKEND_SAMPLING` наследуется child process-ами router-а.

## Типовые проблемы и диагностика

- Нет ускорения: цепочка содержит sampler-ы без backend hooks или sampling не является bottleneck.
- Режим выключился: ищите warning `backend sampling is not compatible with grammar` или `reasoning budget`.
- Для запроса с logprobs проверьте `post_sampling_probs`: pre-sampling logprobs пока несовместимы.
- Trace `sampler chain` и `sampler params` показывают активную цепочку и `backend_sampling`.

## Примеры

```bash
llama-server --model /models/model.gguf --backend-sampling --samplers "top_k;top_p;min_p;temperature"
```

```bash
LLAMA_ARG_BACKEND_SAMPLING=1 llama-server --model /models/model.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/sampling.cpp`
- `llama.cpp/src/llama-sampler.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-task.cpp`
- `llama.cpp/tools/server/README.md`
