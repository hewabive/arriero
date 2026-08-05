---
schema: 1
primaryName: "--warmup"
title: "--warmup"
summary: "Выполняет пустой прогрев модели после создания контекста. По умолчанию включен; `--no-warmup` ускоряет старт, но первая реальная генерация может получить cold-start latency."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--warmup"
  - "--no-warmup"
allowedValues: []
env: []
related:
  - "--embedding"
  - "--rerank"
---

# --warmup

## Кратко

`--warmup` управляет `common_params::warmup`. При default enabled llama.cpp после создания context делает короткий encode/decode с BOS/EOS или fallback token, синхронизирует backend, очищает memory и сбрасывает performance counters.

`--no-warmup` отключает этот шаг.

## Оригинальная справка llama.cpp

```text
whether to perform warmup with an empty run (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--warmup`
- Отрицательная форма: `--no-warmup`
- Поле `common_params`: `warmup`
- По умолчанию: enabled
- Этап применения: после загрузки модели и создания context
- Env: не задан

## Что меняет в llama-server

В `common_init_from_params()` при `params.warmup` логируется `warming up the model with an empty run - please wait ... (--no-warmup to disable)`. Затем вызывается `llama_set_warmup(lctx, true)`, выполняется encoder/decode pass, `llama_memory_clear()`, `llama_synchronize()`, `llama_perf_context_reset()`, и warmup выключается.

Для encoder-decoder моделей warmup учитывает decoder start token. Для decoder-only моделей выполняется decode небольшого batch.

## Значения и формат

Boolean-pair:

- `--warmup`: включить;
- `--no-warmup`: отключить.

## Когда использовать

Оставляйте включенным для production server, где важнее стабильная latency первого запроса и раннее выявление backend проблем.

Используйте `--no-warmup` для быстрых smoke tests, router scenarios с частой загрузкой/выгрузкой моделей или когда startup time критичнее первого request.

## Влияние на производительность и память

Warmup увеличивает время старта и может кратковременно задействовать backend buffers. После warmup memory очищается, поэтому постоянный KV-cache не должен оставаться занят warmup prompt. Зато первая реальная генерация часто становится более предсказуемой по latency.

## Взаимодействие с другими аргументами

- `--embedding` и `--rerank`: warmup выполняется для того же context, но не отправляет embedding/rerank HTTP response.
- GPU/backend flags (`--gpu-layers`, `--flash-attn`, offload-настройки) влияют на стоимость warmup, потому что он прогревает фактический backend path.
- `--perf`: counters сбрасываются после warmup, чтобы не смешивать прогрев с runtime метриками.

## INI-пресеты и router-режим

В INI используйте `warmup = true` или `no-warmup = true`. В router mode `--no-warmup` может заметно ускорить lazy model loading, но первый запрос к каждой модели получит cold-start эффект.

## Типовые проблемы и диагностика

- Старт "завис" на несколько секунд: ищите лог `warming up the model with an empty run`.
- Ошибка backend появляется до первого запроса: warmup обнаружил проблему раньше runtime.
- Первый запрос медленный при `--no-warmup`: это ожидаемый cold start.

## Примеры

```bash
llama-server --model /models/model.gguf --warmup
```

```bash
llama-server --model /models/model.gguf --no-warmup
```

## Источники

- `llama.cpp/common/arg.cpp`: `--warmup`, `--no-warmup`.
- `llama.cpp/common/common.cpp`: warmup encode/decode, memory clear, perf reset.
- `llama.cpp/tools/server/README.md`: server help table.
