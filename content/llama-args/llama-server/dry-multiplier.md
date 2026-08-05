---
schema: 1
primaryName: "--dry-multiplier"
title: "--dry-multiplier"
summary: "Включает и масштабирует DRY repetition penalty. Значение `0.0` отключает DRY, даже если остальные `--dry-*` параметры заданы."
category: "Параметры сэмплинга"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--dry-multiplier"
allowedValues: []
env: []
related:
  - "--dry-base"
  - "--dry-allowed-length"
  - "--dry-penalty-last-n"
  - "--dry-sequence-breaker"
  - "--samplers"
---

# --dry-multiplier

## Кратко

`--dry-multiplier` задает силу DRY sampler. DRY означает "Don't Repeat Yourself": он штрафует токены, которые продолжают уже найденную повторяющуюся последовательность.

Default: `0.00`. При `0.0` DRY отключен по смыслу, хотя сам `dry` sampler остается в default цепочке.

## Оригинальная справка llama.cpp

```text
set DRY sampling multiplier (default: 0.00, 0.0 = disabled)
```

## Паспорт аргумента

- Основное имя: `--dry-multiplier`
- Алиасы: `--dry-multiplier`
- Тип CLI-значения: float `N`
- Поле в `common_params_sampling`: `dry_multiplier`
- HTTP-поле: `dry_multiplier`
- Значение по умолчанию: `0.0`
- CLI-парсер использует `std::stof`; отдельной проверки диапазона в `arg.cpp` нет.

## Что меняет в llama-server

Значение сохраняется в `params.sampling.dry_multiplier`. При инициализации sampler chain `common/sampling.cpp` вызывает `llama_sampler_init_dry(vocab, llama_model_n_ctx_train(model), dry_multiplier, dry_base, dry_allowed_length, dry_penalty_last_n, ...)`.

DRY находится после `penalties` и перед `top_k`/`top_p`/`min_p`/`temperature` в default `--samplers`. Значит, он меняет logits до вероятностных фильтров и до финального sampling.

## Значения и формат

- `0.0`: disabled.
- Положительное значение: включает DRY и масштабирует штраф.
- Чем больше `--dry-multiplier`, тем сильнее подавляются продолжения повторяющихся последовательностей.
- Практически меняйте вместе с `--dry-base`, `--dry-allowed-length` и `--dry-penalty-last-n`; один multiplier без понимания окна часто дает неожиданный результат.

Формула из README для токенов, продолжающих повтор после допустимой длины: `multiplier * base ^ (length of repeating sequence before token - allowed length)`.

## Когда использовать

Включайте DRY, если обычный `--repeat-penalty` недостаточно хорошо ловит длинные циклы: повтор абзаца, фразы, markdown-шаблона, куска кода или однотипных bullets. Для мягкого production default начинайте с небольшого положительного multiplier и коротких тестов на ваших prompt.

Для задач, где повтор структуры обязателен, например JSON массив объектов или однотипные таблицы, DRY может быть слишком агрессивным.

## Влияние на производительность и память

DRY не меняет KV-cache, RAM модели или VRAM. Он добавляет CPU-side работу в sampling и сканирует историю до `--dry-penalty-last-n`. Чем больше окно, тем выше потенциальный overhead на токен.

## Взаимодействие с другими аргументами

- `--dry-base`: задает экспоненциальный рост штрафа.
- `--dry-allowed-length`: сколько токенов повтора разрешено до штрафа.
- `--dry-penalty-last-n`: сколько истории сканировать.
- `--dry-sequence-breaker`: задает границы, на которых DRY не продолжает матчить последовательность.
- `--samplers`: должен содержать `dry`; default содержит его.
- `--mirostat`: при `--mirostat 1/2` обычная цепочка `params.samplers`, включая `dry`, не используется.

## INI-пресеты и router-режим

`--dry-multiplier` помечен как sampling option и разрешен в `--models-preset`.

```ini
[model.default]
dry-multiplier = 0.8
dry-base = 1.75
dry-allowed-length = 2
```

Запрос с JSON-полем `dry_multiplier` переопределяет default процесса для конкретной генерации.

## Типовые проблемы и диагностика

- DRY не влияет: проверьте, что `dry_multiplier` больше `0`, в `--samplers` есть `dry`, а `--mirostat` выключен.
- Модель ломает списки или JSON: уменьшите `--dry-multiplier`, увеличьте `--dry-allowed-length` или настройте sequence breakers.
- Overhead sampling вырос: проверьте `--dry-penalty-last-n`, особенно если используется `-1`.

В trace/debug логах строка `sampler params` печатает `dry_multiplier`, `dry_base`, `dry_allowed_length` и `dry_penalty_last_n`.

## Примеры

```bash
llama-server --model /models/model.gguf --dry-multiplier 0.8 --dry-base 1.75 --dry-allowed-length 2
```

```json
{
  "prompt": "Напиши длинный текст без зацикливания",
  "dry_multiplier": 0.8,
  "dry_base": 1.75,
  "dry_allowed_length": 2
}
```

## Источники

- `llama.cpp/common/arg.cpp`: объявление `--dry-multiplier`.
- `llama.cpp/common/common.h`: defaults DRY и default `samplers`.
- `llama.cpp/common/sampling.cpp`: `llama_sampler_init_dry`.
- `llama.cpp/tools/server/server-task.cpp`: JSON-поля `dry_*`.
- `llama.cpp/tools/server/README.md`: формула и request-параметры DRY.
