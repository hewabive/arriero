---
schema: 1
primaryName: "--lora-init-without-apply"
title: "--lora-init-without-apply"
summary: "Загружает LoRA adapters в память, но не применяет их к контексту на старте. Их можно включить позже через `POST /lora-adapters` или per-request `lora`."
category: "Параметры llama-server"
valueType: "flag"
valueHint: null
aliases:
  - "--lora-init-without-apply"
allowedValues: []
env: []
related:
  - "--lora"
  - "--lora-scaled"
  - "--model"
---

# --lora-init-without-apply

## Кратко

`--lora-init-without-apply` выставляет `common_params.lora_init_without_apply = true`. LoRA adapters все равно загружаются из файлов при старте, но `common_set_adapter_lora()` не вызывается после создания context.

В server README это описано как способ загрузить adapters со scale `0` и применить позже через `POST /lora-adapters`.

## Оригинальная справка llama.cpp

```text
load LoRA adapters without applying them (apply later via POST /lora-adapters) (default: disabled)
```

## Паспорт аргумента

- Основное имя: `--lora-init-without-apply`
- Алиасы: `--lora-init-without-apply`
- Категория в `--help`: `Параметры llama-server`
- Тип значения в arriero: `flag`
- Переменные окружения: не указаны
- Значение по умолчанию: disabled
- Внутреннее поле: `common_params.lora_init_without_apply`

## Что меняет в llama-server

При загрузке модели LoRA-файлы читаются и pointers сохраняются в `params.lora_adapters`. Отличие только в финальном шаге: если флаг включен, код пропускает `common_set_adapter_lora(lctx, params.lora_adapters)`.

После старта:

- `GET /lora-adapters` показывает загруженные adapters;
- `POST /lora-adapters` задает глобальные scale;
- поле `lora` в JSON-запросе может включить adapters для конкретного запроса.

## Значения и формат

Это флаг без значения. Парной отрицательной CLI-формы в проверенном коде нет.

## Когда использовать

Используйте, когда нужно подготовить несколько adapters без влияния на первые запросы и включать их динамически. Это удобно для API-сервера, где разные клиенты выбирают разные LoRA по id.

Не используйте, если adapter должен влиять на все ответы сразу после запуска; тогда достаточно `--lora` или `--lora-scaled`.

## Влияние на производительность и память

Память на adapters все равно расходуется, потому что они загружены. До применения scale runtime overhead минимален относительно активного adapter, но переключение adapters может очищать prompt cache и снижать batching при разных per-request конфигурациях.

## Взаимодействие с другими аргументами

- `--lora`/`--lora-scaled`: задают список adapters, которые будут только инициализированы.
- `POST /lora-adapters`: основной способ включить adapters глобально после старта.
- Request field `lora`: per-request включение без изменения глобального состояния.

## INI-пресеты и router-режим

```ini
[lora_pool]
model = /srv/models/base.gguf
lora = /srv/loras/a.gguf,/srv/loras/b.gguf
lora-init-without-apply = true
```

В router-режиме это позволяет держать pool adapters у конкретного дочернего процесса, но id adapters все равно локальны для этого процесса.

## Типовые проблемы и диагностика

- Adapter загружен, но не влияет: это ожидаемо; проверьте scale через `GET /lora-adapters`.
- После `POST /lora-adapters` старые prompt cache стали невалидны: при смене LoRA server может очистить cache слота.
- Клиент отправляет id вне диапазона: `parse_lora_request()` принимает id/scale, но реально изменяются только существующие indices при построении списка.

## Примеры

```bash
llama-server --model /srv/models/base.gguf --lora /srv/loras/a.gguf,/srv/loras/b.gguf --lora-init-without-apply
```

```bash
curl -X POST http://127.0.0.1:8080/lora-adapters -H 'Content-Type: application/json' -d '[{"id":0,"scale":0.8}]'
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/README.md`
