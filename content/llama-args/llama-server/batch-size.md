---
schema: 1
primaryName: "--batch-size"
title: "--batch-size"
summary: "Логический максимум токенов в batch при обработке prompt и decode. Увеличивает потенциальный throughput prefill, но повышает пиковое потребление памяти."
category: "Общие параметры"
valueType: "number"
valueHint: "N"
aliases:
  - "-b"
  - "--batch-size"
allowedValues: []
env:
  - "LLAMA_ARG_BATCH"
related:
  - "--ubatch-size"
  - "--ctx-size"
  - "--parallel"
  - "--cont-batching"
  - "--threads-batch"
---

# --batch-size

## Кратко

`--batch-size` задает `common_params::n_batch`, затем `llama_context_params::n_batch`: логический максимум токенов, которые сервер пытается собрать в один batch.

Это не то же самое, что `--ubatch-size`. `--batch-size` определяет верхнюю границу работы планировщика, а `--ubatch-size` ограничивает физические micro-batch, на которые backend может дробить вычисление.

## Оригинальная справка llama.cpp

```text
logical maximum batch size (default: 2048)
```

## Паспорт аргумента

- Основное имя: `--batch-size`
- Алиасы: `-b`, `--batch-size`
- Значение: целое число токенов
- Значение по умолчанию: `2048`
- Переменная окружения: `LLAMA_ARG_BATCH`
- Поле llama.cpp: `common_params::n_batch`
- Этап применения: создание `llama_context`, затем цикл `update_slots()`

## Что меняет в llama-server

В `server-context.cpp` сервер собирает pending prompt tokens и generated tokens в `llama_batch`, не превышая `llama_n_batch(ctx_tgt)`. При continuous batching новые промпты могут добавляться к текущему batch, пока есть место и совместимы тип задачи/LoRA.

В `llama-context.cpp` для causal attention фактический `n_batch` ограничивается размером контекста: `min(n_ctx, params.n_batch)`. Для embedding-режима `server.cpp` дополнительно предупреждает и выставляет `n_batch = n_ubatch`, если `--embedding` включен и `n_batch > n_ubatch`.

## Значения и формат

- Положительное число: верхняя граница логического batch.
- `0` не является специальным значением: текущий b10276 доходит с нулевым batch до assertion при резервировании графа. Отрицательные значения также не являются поддерживаемым пользовательским режимом. Arriero отклоняет неположительный batch до расчета памяти.
- Значения ниже 32 могут отключить эффективное использование BLAS, что прямо отмечено в комментарии `common.h`.

## Когда использовать

Увеличивайте `--batch-size`, когда длинные промпты обрабатываются слишком медленно и есть запас VRAM/RAM. Уменьшайте при OOM во время prompt processing, ошибках compute backend или если нужно снизить latency отдельных запросов на загруженном сервере.

Для интерактивного single-user сервера обычно достаточно дефолта. Для API-сервера с несколькими слотами полезно подбирать вместе `--parallel`, `--cont-batching` и `--ubatch-size`.

## Влияние на производительность и память

Большой `--batch-size` может резко ускорить prefill длинных промптов и повысить суммарный throughput при continuous batching. Цена: больше временных буферов, больше нагрузка на backend и потенциально более высокая задержка для маленьких запросов, если они ждут заполнения batch.

Если `--batch-size` сильно больше `--ubatch-size`, вычисление все равно физически пойдет micro-batch кусками, но сервер сможет логически планировать больше токенов за итерацию.

## Взаимодействие с другими аргументами

- `--ubatch-size`: физический лимит; фактический `n_ubatch = min(n_batch, requested_ubatch)` либо `n_batch`, если `--ubatch-size 0`.
- `--ctx-size`: для causal attention ограничивает фактический `n_batch`.
- `--parallel`: batch должен вмещать decode-токены активных слотов; сервер выделяет batch как `max(n_batch, n_parallel)`.
- `--cont-batching`: определяет, будут ли новые промпты добавляться на лету.
- `--threads-batch`: CPU-потоки для batch/prompt phase.

## INI-пресеты и router-режим

В INI используется `batch-size = 2048` или `LLAMA_ARG_BATCH`. Этот аргумент входит в whitelist удаленных presets в `common/preset.cpp`.

В router-режиме значение применяется к дочернему процессу модели; у разных моделей могут быть разные batch-настройки.

## Типовые проблемы и диагностика

- При embedding смотрите предупреждения `embeddings enabled with n_batch (...) > n_ubatch (...)`.
- При OOM на старте или первом запросе сначала уменьшайте `--ubatch-size`, затем `--batch-size`.
- В логах `llama-context` проверяйте фактические `n_batch` и `n_ubatch`, потому что они могут отличаться от argv после ограничений.

## Примеры

```bash
llama-server --model /models/model.gguf --batch-size 1024 --ubatch-size 512
```

```bash
llama-server --model /models/model.gguf --parallel 8 --batch-size 4096 --ubatch-size 1024 --cont-batching
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
