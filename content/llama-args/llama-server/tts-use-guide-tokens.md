---
schema: 1
primaryName: "--tts-use-guide-tokens"
title: "--tts-use-guide-tokens"
summary: "Включает guide tokens для TTS vocoder pipeline, чтобы улучшить word recall. Имеет смысл только в TTS-сценариях с vocoder/model setup, не влияет на обычный chat или embeddings."
category: "Параметры llama-server"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--tts-use-guide-tokens"
allowedValues: []
env: []
related:
  - "--model-vocoder"
---

# --tts-use-guide-tokens

## Кратко

`--tts-use-guide-tokens` ставит `common_params::vocoder.use_guide_tokens = true`. В TTS tool path это заставляет подготовить guide tokens из очищенного prompt text перед генерацией voice codes.

Для обычных `/v1/chat/completions`, `/completion`, `/embedding` и `/reranking` флаг не является meaningful knob.

## Оригинальная справка llama.cpp

```text
Use guide tokens to improve TTS word recall
```

## Паспорт аргумента

- Основное имя: `--tts-use-guide-tokens`
- Тип: флаг без значения
- Поле `common_params`: `vocoder.use_guide_tokens`
- По умолчанию: disabled
- Env: не задан
- Связанный режим: TTS/vocoder

## Что меняет в llama-server

В `arg.cpp` флаг только выставляет поле vocoder params. Реальное использование найдено в `tools/tts/tts.cpp`: при подготовке prompt, после `process_text(params.prompt, tts_version)`, код вызывает `prepare_guide_tokens(vocab, prompt_clean, tts_version)`, если `use_guide_tokens` включен.

В server help аргумент попадает потому, что vocoder-параметры включены для `LLAMA_EXAMPLE_SERVER` в `arg.cpp`, но серверный код ни guide tokens, ни vocoder не использует — речевую генерацию делает `llama-tts`.

## Значения и формат

Флаг без значения:

```bash
llama-server --model /models/tts.gguf --model-vocoder /models/vocoder.gguf --tts-use-guide-tokens
```

Отрицательной формы в `arg.cpp` нет.

## Когда использовать

- TTS модель пропускает или искажает слова из prompt.
- Вы используете OuteTTS-compatible workflow, где guide tokens поддерживаются.
- Есть vocoder model и TTS route/tooling, а не обычная chat модель.

## Влияние на производительность и память

Guide tokens добавляют preprocessing/tokenization work в TTS path и могут увеличить prompt/control data для generation. На chat/embedding server modes не влияют.

## Взаимодействие с другими аргументами

- `--model-vocoder`: практически обязательный сосед для TTS audio generation.
- TTS speaker/audio аргументы влияют на тот же vocoder pipeline.
- `--chat-template`, `--embedding`, `--rerank`: независимые режимы, не используют guide tokens.

## INI-пресеты и router-режим

В INI пишите `tts-use-guide-tokens = true` только в секции TTS-модели. В router mode не смешивайте TTS alias с chat/embedding alias, потому что у клиентов разные endpoint expectations.

## Типовые проблемы и диагностика

- Флаг не меняет chat output: это ожидаемо, он относится к TTS.
- Нет эффекта в TTS: проверьте, что используется vocoder/TTS path, а не обычный text completion.
- Ошибки вокруг vocoder model не исправляются этим флагом; сначала проверьте `--model-vocoder`.

## Примеры

```bash
llama-server --model /models/tts.gguf --model-vocoder /models/vocoder.gguf --tts-use-guide-tokens
```

## Статус в upstream

Upstream [PR #26254](https://github.com/ggml-org/llama.cpp/pull/26254) убирает серверные vocoder/TTS-аргументы; после обновления checkout за эту точку документ будет удален по штатной процедуре. См. `--model-vocoder`.

## Источники

- `llama.cpp/common/arg.cpp`: `--tts-use-guide-tokens`.
- `llama.cpp/common/common.h`: `common_params_vocoder::use_guide_tokens`.
- `llama.cpp/tools/tts/tts.cpp`: `prepare_guide_tokens()` usage in TTS prompt construction.
- `llama.cpp/tools/server/README.md`: server help table includes TTS-facing argument.
