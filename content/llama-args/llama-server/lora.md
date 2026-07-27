---
schema: 1
primaryName: "--lora"
title: "--lora"
summary: "Загружает LoRA/aLoRA adapter с scale `1.0`. Несколько адаптеров можно передать повторением аргумента или CSV-списком; в server их scale можно менять через API."
category: "Общие параметры"
valueType: "list"
valueHint: "FNAME"
aliases:
  - "--lora"
allowedValues: []
env: []
related:
  - "--lora-scaled"
  - "--lora-init-without-apply"
  - "--model"
  - "--alias"
---

# --lora

## Кратко

`--lora` добавляет LoRA adapter к списку `common_params.lora_adapters` со scale `1.0`. Обработчик разбирает CSV через `parse_csv_row()`, поэтому один аргумент может содержать несколько путей, а сам аргумент можно повторять.

В `llama-server` adapters загружаются на старте вместе с моделью, а затем могут применяться глобально через `POST /lora-adapters` или per-request через JSON-поле `lora`.

## Оригинальная справка llama.cpp

```text
path to LoRA adapter (use comma-separated values to load multiple adapters)
```

## Паспорт аргумента

- Основное имя: `--lora`
- Алиасы: `--lora`
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `list`
- Подсказка формата из `--help`: `FNAME`
- Переменные окружения: не указаны
- Значение по умолчанию: adapters не загружаются
- Внутреннее поле: `common_params.lora_adapters`

## Что меняет в llama-server

Парсер добавляет для каждого пути структуру `{ path, 1.0, "", "", nullptr }`. При загрузке модели `common.cpp` вызывает `llama_adapter_lora_init(model, path)`, читает metadata `adapter.lora.task_name` и `adapter.lora.prompt_prefix`, сохраняет pointer и держит adapter в памяти.

Если `--lora-init-without-apply` не задан, после создания context вызывается `common_set_adapter_lora(ctx, params.lora_adapters)`, то есть adapters применяются сразу.

В server runtime:

- `GET /lora-adapters` возвращает id, path, scale и aLoRA invocation data;
- `POST /lora-adapters` меняет глобальные scale;
- JSON field `lora` в запросе переопределяет scale только для этого запроса;
- запросы с разной LoRA-конфигурацией не batching together, что может снижать throughput.

## Значения и формат

Ожидается путь к LoRA adapter file, совместимому с базовой моделью. Несколько значений:

```text
--lora a.gguf,b.gguf
--lora a.gguf --lora b.gguf
```

Если путь содержит запятую, CSV-разбор может воспринять ее как разделитель; такие имена лучше избегать.

## Когда использовать

Используйте `--lora`, когда adapter должен быть доступен серверу сразу после старта. Для динамического включения/выключения без перезапуска загрузите adapters на старте и управляйте scale через `/lora-adapters` или per-request `lora`.

Для scale, отличного от `1.0`, используйте `--lora-scaled`.

## Влияние на производительность и память

Каждый adapter загружается в память и добавляет работу при forward pass, если scale не `0`. Разные LoRA-конфигурации мешают batching: README прямо предупреждает, что запросы с разной `lora` конфигурацией не будут батчиться вместе.

При смене LoRA у слота server может очистить prompt cache. Для aLoRA есть специальная логика, которая может сохранить cache до invocation prefix.

## Взаимодействие с другими аргументами

- `--model`: adapter должен быть совместим с базовой моделью.
- `--lora-scaled`: добавляет adapters с явным scale.
- `--lora-init-without-apply`: загружает adapters, но стартовый scale выставляет в `0`/не применяет до API.
- Request field `lora`: per-request override scale по id adapter.

## INI-пресеты и router-режим

```ini
[model_with_lora]
model = /srv/models/base.gguf
lora = /srv/loras/domain.gguf
```

Для нескольких adapters в preset используйте CSV или повторяемые ключи, если текущий preset parser вашей версии это поддерживает. В router-режиме adapters должны быть доступны дочернему процессу по тем же путям.

## Типовые проблемы и диагностика

- `failed to load lora adapter '<path>'`: файл отсутствует, поврежден или несовместим.
- Adapter загружен, но не влияет: проверьте scale через `GET /lora-adapters`.
- Throughput просел: проверьте, не отправляют ли клиенты разные per-request `lora`.
- aLoRA не активируется: invocation sequence не найдена в prompt, server логирует deactivation на debug level.

## Примеры

```bash
llama-server --model /srv/models/base.gguf --lora /srv/loras/domain.gguf
```

```bash
llama-server --model /srv/models/base.gguf --lora /srv/loras/a.gguf,/srv/loras/b.gguf
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- `llama.cpp/tools/server/server-common.cpp`
- `llama.cpp/tools/server/README.md`
