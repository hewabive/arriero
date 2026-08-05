---
schema: 1
primaryName: "--spec-ngram-mod-n-match"
title: "--spec-ngram-mod-n-match"
summary: "Длина n-gram ключа, который `ngram-mod` хеширует для поиска следующего токена. Слишком малые значения дают больше ложных совпадений; в текущем коде `n_match < 16` специально сопровождается предупреждением."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-mod-n-match"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-default"
  - "--spec-ngram-mod-n-min"
  - "--spec-ngram-mod-n-max"
  - "--spec-ngram-simple-size-n"
  - "--spec-ngram-map-k-size-n"
  - "--spec-ngram-map-k4v-size-n"
---

# --spec-ngram-mod-n-match

## Кратко

`--spec-ngram-mod-n-match` задает длину последовательности токенов, по которой `ngram-mod` строит hash key. Для каждого такого n-gram hash pool хранит один следующий токен; при генерации алгоритм повторно вычисляет hash последних `n_match` токенов и берет сохраненное продолжение.

Это аналог `size-n` для map-вариантов, но у `ngram-mod` имя другое, потому что он хранит не m-gram после ключа, а один следующий токен и набирает черновик итеративно.

## Оригинальная справка llama.cpp

```text
ngram-mod lookup length (default: 24)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-mod-n-match`
- Алиасы: нет
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения: целое число `N`
- Значение по умолчанию: `24`
- Допустимый диапазон по CLI-парсеру: `1..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_mod.n_match`
- Применяется: при создании `common_ngram_mod(n_match, 4*1024*1024)` и во всех lookup/add операциях hash pool

## Что меняет в llama-server

При `begin` для каждого слота `ngram-mod` добавляет n-grams из prompt/history в общий hash pool. При генерации используется окно длины `n_match`; найденный следующий токен добавляется в черновик, затем окно сдвигается и lookup повторяется до `--spec-ngram-mod-n-max`.

Hash pool общий для всех server slots, поэтому совпадения могут переноситься между параллельными запросами. Это полезно для похожих запросов и редактирования кода, но на публичном multi-tenant сервере учитывайте, что статистика токенов не изолирована между клиентами.

## Значения и формат

- `1..1024` разрешены.
- `0`, отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram size N must be between 1 and 1024 inclusive`.
- При `n_match < 16` llama.cpp пишет предупреждение `ngram_mod n_match=... is too small - poor quality is possible`.

## Когда использовать

Оставляйте `24` как стартовую точку. Уменьшайте осторожно, если нужны совпадения на коротких повторах и acceptance rate остается приемлемой. Увеличивайте, если появляются короткие, но неверные продолжения, низкая acceptance rate или частые reset hash pool из-за плохих догадок.

## Влияние на производительность и память

Размер hash pool фиксирован примерно в 16 MiB и не растет от `n_match`. Больший `n_match` делает совпадения более специфичными: обычно меньше черновиков, но выше точность. Меньший `n_match` чаще находит продолжения, но может увеличить количество отклоненных токенов.

## Взаимодействие с другими аргументами

- `--spec-type ngram-mod` или `--spec-default` нужны для активации.
- `--spec-ngram-mod-n-min` и `--spec-ngram-mod-n-max` задают минимальную и максимальную длину результата после lookup по этому ключу.
- Удаленный legacy-аргумент `--spec-ngram-size-n` больше не задает этот параметр; для `ngram-mod` используйте именно `--spec-ngram-mod-n-match`.
- При одновременном включении нескольких speculative типов порядок приоритета в коде: `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache`, затем draft model варианты.

## INI-пресеты и router-режим

```ini
spec-type = ngram-mod
spec-ngram-mod-n-match = 24
```

Параметр допустим в `--models-preset` как обычный ключ без ведущих дефисов. Router не управляет им специально.

## Типовые проблемы и диагностика

- Старт падает: проверьте диапазон `1..1024`.
- В логах предупреждение про `n_match` меньше `16`: это не fatal error, но качество speculative догадок может быть плохим.
- Hash pool сбрасывается по occupancy: в логах будет `ngram_mod occupancy ... exceeds threshold ... resetting`; это связано с заполнением общей таблицы, а не с ошибкой формата.
- Для анализа используйте `statistics ngram_mod` и acceptance ratio в конце запроса.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-match 24 --spec-ngram-mod-n-min 48 --spec-ngram-mod-n-max 64
```

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-match 32 --spec-ngram-mod-n-min 32 --spec-ngram-mod-n-max 64
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-mod.h`
- `llama.cpp/common/ngram-mod.cpp`
- `llama.cpp/docs/speculative.md`
