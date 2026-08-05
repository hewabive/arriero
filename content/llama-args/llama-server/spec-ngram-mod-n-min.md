---
schema: 1
primaryName: "--spec-ngram-mod-n-min"
title: "--spec-ngram-mod-n-min"
summary: "Минимальная длина черновика для `ngram-mod`: если общий n-gram hash pool не может продолжить последовательность хотя бы на это число токенов, черновик отбрасывается. Работает только при включенном `--spec-type ngram-mod` или `--spec-default`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-mod-n-min"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-default"
  - "--spec-ngram-mod-n-match"
  - "--spec-ngram-mod-n-max"
  - "--spec-draft-n-max"
---

# --spec-ngram-mod-n-min

## Кратко

`--spec-ngram-mod-n-min` задает нижний порог длины черновика для реализации `ngram-mod`. Если lookup по rolling n-gram hash остановился раньше этого порога, `llama-server` очищает черновик и текущий шаг идет без speculative ускорения.

Параметр не включает speculative decoding сам по себе. Для использования нужен `--spec-type ngram-mod` или пресет `--spec-default`, который в текущем commit включает `ngram-mod` с `n_match=24`, `n_min=48`, `n_max=64`.

## Оригинальная справка llama.cpp

```text
minimum number of ngram tokens to use for ngram-based speculative decoding (default: 48)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-mod-n-min`
- Алиасы: нет
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения: целое число `N`
- Значение по умолчанию: `48`
- Допустимый диапазон по CLI-парсеру: `0..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_mod.n_min`
- Применяется: при инициализации `common_speculative_impl_ngram_mod` и при каждом построении черновика

## Что меняет в llama-server

`ngram-mod` хранит общий для всех server slots hash pool: ключом является n-gram длины `--spec-ngram-mod-n-match`, значением - следующий токен. При генерации он итеративно строит до `--spec-ngram-mod-n-max` токенов. Если очередной hash lookup не нашел токен и уже собрано меньше `--spec-ngram-mod-n-min`, результат очищается.

На практике это фильтр качества: низкое значение чаще позволяет короткие черновики, высокое значение требует длинного непрерывного совпадения и снижает число speculative попыток.

## Значения и формат

- `0` разрешен и означает "не требовать минимальной длины": любой найденный непустой черновик может быть использован.
- `1..1024` разрешены.
- Отрицательные значения и значения больше `1024` отклоняются на этапе парсинга с ошибкой `ngram n-min must be between 0 and 1024 inclusive`.
- Если `--spec-ngram-mod-n-min` больше `--spec-ngram-mod-n-max`, обычный черновик фактически будет отбрасываться, потому что алгоритм не сможет достичь минимальной длины в пределах максимума.

## Когда использовать

Увеличивайте значение для повторяющихся длинных фрагментов, кода, reasoning-output и MoE-моделей, где короткие догадки часто дают мало пользы. Уменьшайте для dense-моделей или коротких повторов, если в статистике почти нет `ngram_mod` черновиков.

## Влияние на производительность и память

Память напрямую не меняется: `ngram-mod` создает таблицу на `4*1024*1024` записей токенов, около 16 MiB, независимо от `n_min`. Влияние идет через число и длину черновиков: слишком высокий порог уменьшает попытки speculation, слишком низкий может увеличить проверки главным контекстом с низкой acceptance rate.

## Взаимодействие с другими аргументами

- `--spec-type ngram-mod` включает реализацию; без него параметр только сохраняется в конфиге.
- `--spec-default` выставляет этот параметр в `48`.
- `--spec-ngram-mod-n-match` задает длину ключевого n-gram; при `n_match < 16` llama.cpp печатает предупреждение о возможном плохом качестве.
- `--spec-ngram-mod-n-max` ограничивает верхнюю длину черновика; держите `n_min <= n_max`.
- `--spec-draft-n-max` дополнительно ограничивает максимальный черновик на уровне server slot и доступного контекста.

## INI-пресеты и router-режим

В `--models-preset` ключ пишется без ведущих дефисов:

```ini
spec-type = ngram-mod
spec-ngram-mod-n-min = 48
```

Параметр не относится к аргументам, которые router удаляет или перезаписывает при загрузке модели. Он наследуется модельным подпроцессом как обычный CLI-аргумент.

## Типовые проблемы и диагностика

- Сервер не стартует: проверьте диапазон `0..1024`.
- Черновики не появляются: проверьте, что включен `--spec-type ngram-mod`, а в логах есть `adding speculative implementation 'ngram-mod'`.
- Мало пользы от speculation: сравните строки `draft acceptance = ...` и `statistics ngram_mod: #gen drafts ... #gen tokens ... #acc tokens ...`.
- В логах есть `low acceptance streak ... resetting ngram_mod` при `LLAMA_TRACE`: hash pool часто дает плохие продолжения; попробуйте увеличить `--spec-ngram-mod-n-match` или `--spec-ngram-mod-n-min`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-match 24 --spec-ngram-mod-n-min 48 --spec-ngram-mod-n-max 64
```

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-min 0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-mod.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/README.md`
