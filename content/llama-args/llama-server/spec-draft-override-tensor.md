---
schema: 1
primaryName: "--spec-draft-override-tensor"
title: "--spec-draft-override-tensor"
summary: "Переопределяет buffer type отдельных tensor draft-модели по regex-like pattern. Используется для точечного размещения draft tensor на CPU/GPU поверх общего `--spec-draft-ngl`."
category: "Параметры speculative decoding"
valueType: "list"
estimation: "normal"
valueHint: "<tensor name pattern>=<buffer type>,..."
aliases:
  - "--spec-draft-override-tensor"
  - "-otd"
  - "--override-tensor-draft"
allowedValues: []
env: []
related:
  - "--override-tensor"
  - "--spec-draft-ngl"
  - "--spec-draft-device"
  - "--spec-draft-cpu-moe"
  - "--spec-draft-n-cpu-moe"
---

# --spec-draft-override-tensor

## Кратко

`--spec-draft-override-tensor` добавляет правила `llama_model_tensor_buft_override` только для draft-модели. Значение парсится как список `pattern=buffer_type` через запятую и записывается в `common_params.speculative.draft.tensor_buft_overrides`.

После парсинга llama.cpp добавляет завершающий `{nullptr, nullptr}` sentinel, если список override не пуст.

## Оригинальная справка llama.cpp

```text
override tensor buffer type for draft model
```

## Паспорт аргумента

- Основное имя: `--spec-draft-override-tensor`
- Алиасы: `--spec-draft-override-tensor`, `-otd`, `--override-tensor-draft`
- Формат: `<tensor name pattern>=<buffer type>,...`
- Структура llama.cpp: `common_params.speculative.draft.tensor_buft_overrides`
- Переменная окружения: нет
- Этап применения: парсинг CLI, затем загрузка draft-модели

## Что меняет в llama-server

При загрузке draft-модели сервер копирует список в `params_dft.tensor_buft_overrides`. Загрузчик модели использует его для выбора buffer type отдельных tensor. На target-модель этот аргумент не влияет; для target существует отдельный `--override-tensor`.

`parse_tensor_buffer_overrides()` собирает доступные buffer types из загруженных backend devices. Если buffer type неизвестен, печатает список доступных buffer types и выбрасывает `unknown buffer type`.

## Значения и формат

Каждый элемент обязан содержать `=`. Левая часть - pattern имени tensor, правая - точное имя buffer type, как его печатает backend. Разделитель элементов - запятая.

Пример формы: `blk\.0.*=CPU`. Реальные имена buffer type зависят от сборки и backend, поэтому перед постоянной настройкой проверьте лог ошибки или вывод backend.

## Когда использовать

Это низкоуровневый инструмент для случаев, когда общих `--spec-draft-ngl`, `--spec-draft-device` и MoE CPU-флагов недостаточно. Типичный сценарий - оставить тяжелые или редко используемые tensor draft-модели на CPU, а остальное выгрузить на GPU.

Для MoE обычно проще использовать `--spec-draft-cpu-moe` или `--spec-draft-n-cpu-moe`, потому что они генерируют готовые patterns для expert tensor.

## Влияние на производительность и память

Перенос tensor на CPU экономит VRAM draft-модели, но может добавить CPU/GPU transfer и увеличить draft latency. Если draft становится медленнее target-подтверждения, speculative decoding может потерять смысл.

Сравнивайте VRAM, token/s и `draft acceptance` до и после override.

## Взаимодействие с другими аргументами

`--spec-draft-ngl` задает общий уровень offload, а override точечно меняет buffer type. `--spec-draft-cpu-moe` и `--spec-draft-n-cpu-moe` добавляют свои override в тот же список; порядок добавления соответствует порядку парсинга аргументов и env.

## INI-пресеты и router-режим

В INI задавайте значение одной строкой, например `override-tensor-draft = blk\\.0.*=CPU`. Экранирование зависит от INI-парсера и shell здесь не участвует, поэтому проверяйте фактический argv/subprocess log.

## Типовые проблемы и диагностика

- `invalid value`: один из элементов не содержит `=`.
- `unknown buffer type`: имя buffer type не существует в текущей сборке/backend.
- Сервер стартует, но draft медленный: override перенес слишком много tensor на CPU.

## Примеры

```bash
llama-server --model /models/target.gguf --spec-draft-model /models/draft.gguf --spec-draft-override-tensor blk\\.0.*=CPU
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/tools/server/server-context.cpp`
