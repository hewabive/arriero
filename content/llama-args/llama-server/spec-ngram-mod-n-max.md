---
schema: 1
primaryName: "--spec-ngram-mod-n-max"
title: "--spec-ngram-mod-n-max"
summary: "Максимальная длина черновика, который `ngram-mod` может предложить за один speculative шаг. Ограничивает объем проверки главным контекстом и должен быть согласован с `--spec-ngram-mod-n-min` и `--spec-draft-n-max`."
category: "Параметры speculative decoding"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--spec-ngram-mod-n-max"
allowedValues: []
env: []
related:
  - "--spec-type"
  - "--spec-default"
  - "--spec-ngram-mod-n-match"
  - "--spec-ngram-mod-n-min"
  - "--spec-draft-n-max"
---

# --spec-ngram-mod-n-max

## Кратко

`--spec-ngram-mod-n-max` задает, сколько токенов максимум реализация `ngram-mod` попытается набрать из общего n-gram hash pool за один шаг. Это верхний предел именно для `ngram-mod`; сервер также может обрезать черновик по доступному контексту и по общему slot-лимиту `--spec-draft-n-max`.

Параметр используется только когда активна реализация `ngram-mod`: через `--spec-type ngram-mod` или через `--spec-default`.

## Оригинальная справка llama.cpp

```text
maximum number of ngram tokens to use for ngram-based speculative decoding (default: 64)
```

## Паспорт аргумента

- Основное имя: `--spec-ngram-mod-n-max`
- Алиасы: нет
- Категория в `--help`: `Параметры speculative decoding`
- Тип значения: целое число `N`
- Значение по умолчанию: `64`
- Допустимый диапазон по CLI-парсеру: `0..1024`
- Переменные окружения: нет
- Внутреннее поле: `common_params.speculative.ngram_mod.n_max`
- Применяется: при построении черновика в `common_speculative_impl_ngram_mod::draft_one`

## Что меняет в llama-server

Алгоритм `ngram-mod` берет последние `n_match` токенов, ищет следующий токен в hash pool, затем сдвигает окно и повторяет цикл до `n_max` раз. Если lookup прерывается раньше `--spec-ngram-mod-n-min`, черновик отбрасывается; если позже, возвращается найденная длина.

Значение `n_max` не гарантирует, что столько токенов будет проверено: черновик может быть короче из-за отсутствия продолжения, из-за `n_min`, из-за лимита слота или из-за конца генерации.

## Значения и формат

- `0` разрешен. При `0` цикл построения не добавляет токены, поэтому `ngram-mod` практически не генерирует черновики.
- `1..1024` разрешены.
- Отрицательные значения и значения больше `1024` отклоняются с ошибкой `ngram n-max must be between 0 and 1024 inclusive`.
- Для рабочего режима обычно нужно `--spec-ngram-mod-n-max >= --spec-ngram-mod-n-min`.

## Когда использовать

Увеличивайте `n_max`, если модель часто повторяет длинные блоки и acceptance rate остается высокой. Уменьшайте, если latency отдельных шагов растет, много черновиков отклоняется или генерация идет на коротких ответах, где длинная проверка не окупается.

## Влияние на производительность и память

Память hash pool не зависит от `n_max`. Рост `n_max` увеличивает потенциальную длину batch-проверки главным контекстом: при высокой доле принятых токенов это ускоряет throughput, при плохих совпадениях добавляет лишнюю работу и откаты speculative checkpoint.

## Взаимодействие с другими аргументами

- `--spec-type ngram-mod` включает реализацию.
- `--spec-default` выставляет `--spec-ngram-mod-n-max 64`.
- `--spec-ngram-mod-n-min` должен быть не больше `n_max`, иначе черновики почти всегда будут очищаться.
- `--spec-ngram-mod-n-match` влияет на качество совпадений: короткий ключ чаще дает ложные продолжения.
- `--spec-draft-n-max` и доступный размер контекста дополнительно ограничивают итоговую длину черновика в server slot.

## INI-пресеты и router-режим

```ini
spec-type = ngram-mod
spec-ngram-mod-n-max = 64
```

В router-режиме параметр может находиться в глобальной секции `[*]` или в секции конкретной модели. Он не входит в список аргументов, которые router принудительно заменяет.

## Типовые проблемы и диагностика

- `--spec-ngram-mod-n-max 0` не является способом "частично включить" speculation: черновиков от `ngram-mod` не будет.
- Если `#gen tokens` намного больше `#acc tokens` в `statistics ngram_mod`, уменьшите `n_max` или увеличьте `n_match`.
- Если `#gen drafts` низкий, проверьте `n_min`, наличие повторов в запросе и включение `ngram-mod`.
- В логах инициализации должны быть строки `adding speculative implementation 'ngram-mod'` и `- n_match=..., n_max=..., n_min=...`.

## Примеры

```bash
llama-server --model /models/model.gguf --spec-type ngram-mod --spec-ngram-mod-n-match 24 --spec-ngram-mod-n-min 32 --spec-ngram-mod-n-max 48
```

```bash
llama-server --model /models/model.gguf --spec-default
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/ngram-mod.cpp`
- `llama.cpp/docs/speculative.md`
- `llama.cpp/tools/server/README.md`
