---
schema: 1
primaryName: "--check-tensors"
title: "--check-tensors"
summary: "Проверяет данные тензоров модели на недопустимые значения во время загрузки. Замедляет старт, но помогает диагностировать поврежденные или некорректные GGUF."
category: "Общие параметры"
valueType: "flag"
estimation: "normal"
valueHint: null
aliases:
  - "--check-tensors"
allowedValues: []
env: []
related:
  - "--direct-io"
  - "--mmap"
---

# --check-tensors

## Кратко

`--check-tensors` включает валидацию tensor data при загрузке модели. Если loader находит недопустимые значения для типа тензора, загрузка завершается ошибкой вида `tensor '<name>' has invalid data`.

## Оригинальная справка llama.cpp

```text
check model tensor data for invalid values (default: false)
```

## Паспорт аргумента

- Основное имя: `--check-tensors`
- Тип: флаг
- Переменная окружения: отсутствует в `arg.cpp`
- Поле `common_params`: `check_tensors`
- Поле `llama_model_params`: `check_tensors`
- Значение по умолчанию: `false`
- Этап применения: загрузка GGUF tensor data

## Что меняет в llama-server

Парсер выставляет `params.check_tensors = true`. Loader вызывает `ggml_validate_row_data()` для тензоров, которые читает из mmap или file buffers.

При mmap проверка может выполняться асинхронно по mapped data. При чтении без mmap проверка идет по host/read buffer или непосредственно по tensor memory.

## Значения и формат

Флаг без значения. Env-переменная для него не подключена в проверенном `arg.cpp`.

## Когда использовать

Используйте для диагностики подозрительных GGUF: неожиданные NaN/Inf, падения при загрузке, разные результаты после скачивания, ошибки storage. Для обычного production-start лучше выключить, если модель уже проверена.

## Влияние на производительность и память

Флаг замедляет старт, потому что данные тензоров дополнительно читаются/проверяются. Он может также отключить async upload path в loader: код не использует upload backend, если `use_mmap` или `check_tensors` истинны.

На runtime generation после загрузки напрямую не влияет.

## Взаимодействие с другими аргументами

`--mmap` определяет, проверяются ли данные из mapped region.

`--direct-io` и `--no-mmap` меняют путь чтения, но сама проверка остается на уровне tensor data.

`--override-tensor` может перемещать тензоры между buffer types; проверка данных при этом остается проверкой значений, а не совместимости backend operation.

## INI-пресеты и router-режим

В INI:

```ini
check-tensors = true
```

В router-режиме не включайте глобально без необходимости: каждая загрузка модели будет платить временем проверки.

## Типовые проблемы и диагностика

- `tensor '<name>' has invalid data`: перескачайте GGUF, проверьте hash/размер файла и storage.
- Старт стал заметно дольше: это ожидаемо; выключите после диагностики.
- Ошибка появляется только с Direct I/O: повторите без `--direct-io`, чтобы отделить проблему чтения от проблемы данных.

## Примеры

```bash
llama-server --model /models/model.gguf --check-tensors
```

```bash
llama-server --model /models/model.gguf --check-tensors --no-mmap
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-model-loader.cpp`
- `llama.cpp/tools/server/README.md`
