---
schema: 1
engine: sglang
primaryName: "--language-model-only"
title: "--language-model-only"
summary: Запускает поддерживаемый multimodal checkpoint без encoder/vision tower и обслуживает только текст. Освобожденная VRAM остается доступна для KV cache, но режим сейчас ограничен архитектурой Muse Glimmer.
group: disagg
related:
  - --language-only
  - --encoder-only
  - --disaggregation-mode
  - --enable-prefix-mm-cache
  - --mm-enable-dp-encoder
  - --mem-fraction-static
---

# --language-model-only

## Кратко

Флаг превращает поддерживаемый мультимодальный checkpoint в самостоятельный text-only сервер: tokenizer manager не строит multimodal processor, model loader не создает encoder/vision tower, а запросы с image/video/audio отклоняются. В отличие от `--language-only`, это не decoder-часть encoder/decoder disaggregation.

## Оригинальная справка

```text
Skip the multimodal encoder entirely: its weights are never loaded and the tower is never built, freeing that GPU memory for KV cache. Multimodal requests are rejected. Unlike --language-only this is a standalone mode, not part of encoder/decoder disaggregation.
```

## Паспорт аргумента

- Флаги: `--language-model-only`
- Группа: `disagg`
- Тип значения: bool, флаг без значения
- Значение по умолчанию: `false`
- Где объявлен: `ServerArgs.language_model_only`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: проверка аргументов/model architecture → построение `ModelConfig` → tokenizer/processor init → загрузка весов модели → валидация запросов

## Что меняет в движке

`_handle_language_model_only` сейчас разрешает CLI-флаг только для `MuseGlimmerForConditionalGeneration`. Затем `ModelConfig` записывает `hf_config.language_model_only=True`. Конструктор Muse Glimmer не создает `vision_tower`, `vision_adapter`, `vision_projection` и `perception_emb_norm`, а forward сразу использует language model embeddings.

Tokenizer manager и scheduler пропускают multimodal processor. Если запрос все же содержит media, tokenizer manager возвращает `ValueError` до model forward. Checkpoint, уже помеченный `language_model_only=True`, также остается text-only даже без CLI-флага.

## Значения и формат

Булев флаг без значения. Это не универсальный способ отключить vision tower любой VLM: неподдержанная architecture приводит к ошибке на старте с перечнем разрешенных классов.

## Когда использовать

Используйте для text-only обслуживания Muse Glimmer checkpoint, когда encoder не нужен и VRAM важнее multimodal capability. Для разделенного encoder/decoder deployment используйте `--encoder-only`/`--language-only`, а не этот standalone-режим.

## Влияние на производительность и память

Вес vision tower и его постоянные buffers не загружаются, старт быстрее, а больше свободной VRAM может попасть в KV budget. Image preprocessing и encoder compute исчезают. Скорость чистого language-model decode не меняется.

## Взаимодействие с другими аргументами

- Несовместим с `--encoder-only`, `--language-only`, `--enable-prefix-mm-cache`, `--enable-broadcast-mm-inputs-process` и `--mm-enable-dp-encoder`.
- `--disaggregation-mode` должен оставаться строкой `null`; `prefill`/`decode` запрещены.
- `--mem-fraction-static` по-прежнему задает долю VRAM для модели и KV, но база свободной памяти становится больше без encoder weights.

## Типовые проблемы и диагностика

- `--language-model-only does not support [...]` — architecture не входит в текущий allowlist.
- `--language-model-only cannot be combined with ...` — выбран конфликтующий encoder/MM режим.
- `Multimodal inputs are not supported when --language-model-only is set` — клиент прислал media на text-only endpoint.
- Отсутствие инициализации MM processor и `language_model_only=True` в конфигурации подтверждают активный режим.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Muse-Glimmer --language-model-only --mem-fraction-static 0.88
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/models/muse_glimmer.py`

