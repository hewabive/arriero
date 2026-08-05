---
schema: 1
primaryName: "--spec-draft-backend-sampling"
title: "--spec-draft-backend-sampling"
summary: "Включает или отключает backend-side sampling для MTP/Eagle3 draft-контекста. По умолчанию включено; отрицательная форма `--no-spec-draft-backend-sampling` возвращает sampling на CPU path."
category: "Параметры speculative decoding"
valueType: "boolean"
valueHint: null
aliases:
  - "--spec-draft-backend-sampling"
  - "--no-spec-draft-backend-sampling"
allowedValues: []
env:
  - "LLAMA_ARG_SPEC_DRAFT_BACKEND_SAMPLING"
  - "LLAMA_ARG_NO_SPEC_DRAFT_BACKEND_SAMPLING"
related:
  - "--backend-sampling"
  - "--spec-type"
  - "--spec-draft-p-min"
  - "--spec-draft-model"
---

# --spec-draft-backend-sampling

## Кратко

`--spec-draft-backend-sampling` управляет `common_params.speculative.draft.backend_sampling`. По умолчанию значение `true`: MTP и Eagle3 draft implementations пытаются привязать sampler chain к draft-контексту backend через `llama_set_sampler()`.

Для отключения используйте отрицательную форму `--no-spec-draft-backend-sampling`. Это boolean-аргумент с парой positive/negative flags, а не аргумент со значением `true`.

## Оригинальная справка llama.cpp

```text
offload draft sampling to the backend (default: enabled)
```

## Паспорт аргумента

- Основное имя: `--spec-draft-backend-sampling`
- Отрицательная форма: `--no-spec-draft-backend-sampling`
- Структура llama.cpp: `common_params.speculative.draft.backend_sampling`
- Переменные окружения: `LLAMA_ARG_SPEC_DRAFT_BACKEND_SAMPLING`, совместимая отрицательная `LLAMA_ARG_NO_SPEC_DRAFT_BACKEND_SAMPLING`
- Значение по умолчанию: `enabled`
- Подтвержденное применение: MTP и Eagle3 draft implementations

## Что меняет в llama-server

В `common_speculative_impl_draft_mtp` и `common_speculative_impl_draft_eagle3` при `backend_sampling = true` для каждой sequence создается sampler chain с `top_k(10)` и вызывается `llama_set_sampler(ctx_dft, seq_id, chain)`. Если backend offload не удался, код пишет warning `backend offload failed ...; using CPU sampler` и продолжает с CPU sampler.

В `draft-simple` поле `backend_sampling` не читается: там sampler создается и вызывается через common sampler path.

## Значения и формат

CLI:

```text
--spec-draft-backend-sampling
--no-spec-draft-backend-sampling
```

Env принимает обычные truthy/falsey boolean-строки через общий parser. Для отрицательной формы llama.cpp также добавляет `LLAMA_ARG_NO_...` compatibility env.

## Когда использовать

Оставляйте включенным для `--spec-type draft-mtp`/`draft-eagle3`, если backend поддерживает sampler attachment и это снижает overhead. Отключайте при диагностике backend-specific ошибок, несовместимости sampler offload или если нужно сравнить CPU и backend sampling.

Для `draft-simple` этот флаг не является основным тюнингом; смотрите `--backend-sampling` для основного server sampling и `--spec-draft-p-min`/`--spec-draft-n-max` для draft поведения.

## Влияние на производительность и память

Draft context заранее резервирует дополнительные host output arrays: две F32 строки `n_vocab` для logits/probabilities, token candidates длиной `n_vocab` и sampled token на slot. Добавка равна `(3 * n_vocab_draft + 1) * n_parallel * 4` bytes. `--no-spec-draft-backend-sampling` убирает эти arrays. Arriero включает их для MTP/Eagle3; generic draft-simple и DFlash/DSpark в текущем коде не устанавливают эти backend sampler chains.

Сравнивайте token/s и `draft acceptance`; сам флаг не меняет acceptance напрямую, но может менять стоимость draft generation.

## Взаимодействие с другими аргументами

`--backend-sampling` управляет основным sampling сервера и в `server-context.cpp` отключается для слота, если слот использует speculative decoding. `--spec-draft-backend-sampling` относится к draft/MTP sampler chain и хранится в другой структуре.

`--spec-draft-p-min` использует probability candidates, полученные draft sampler; при backend fallback логика порога остается той же.

## INI-пресеты и router-режим

В INI positive форма обычно задается `spec-draft-backend-sampling = true`, отрицательная - `no-spec-draft-backend-sampling = true` или через env `LLAMA_ARG_NO_SPEC_DRAFT_BACKEND_SAMPLING=1`. Так как default уже enabled, явно задавать positive форму обычно не нужно.

## Типовые проблемы и диагностика

- `backend offload failed ...; using CPU sampler`: backend не принял sampler chain; для проверки задайте `--no-spec-draft-backend-sampling`.
- Нет эффекта на `draft-simple`/DFlash/DSpark: это ожидаемо; поле используется реализациями MTP и Eagle3.
- Пользователь передал `--spec-draft-backend-sampling true`: CLI parser воспримет `true` как следующий аргумент и запуск упадет; используйте флаг без значения.

## Примеры

```bash
llama-server --model /models/target-with-mtp.gguf --spec-type draft-mtp --no-spec-draft-backend-sampling
```

```bash
llama-server --model /models/target-with-mtp.gguf --spec-type draft-mtp --spec-draft-backend-sampling
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
