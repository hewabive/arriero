---
schema: 1
primaryName: "--argument-name"
title: "--argument-name"
summary: Короткое техническое резюме в 1-2 предложения.
category: null
valueType: null
valueHint: null
aliases:
  - --argument-name
allowedValues: []
env: []
related:
  - --related-argument
---

# --argument-name

## Кратко

Опишите, что делает аргумент и когда инженер обычно должен о нем думать.

## Оригинальная справка llama.cpp

```text
Вставьте строку или фрагмент из `llama-server --help`.
```

## Паспорт аргумента

- Основное имя: `--argument-name`
- Алиасы: `--argument-name`
- Категория в `--help`: `TODO`
- Тип значения в arriero: `TODO`
- Подсказка формата из `--help`: `TODO`
- Допустимые значения из `--help`: `TODO`
- Переменные окружения: `TODO`
- Значение по умолчанию из `--help`: `TODO`

## Что меняет в llama-server

Разберите фактическое поведение: какой subsystem затрагивается, какие значения принимаются, что происходит при отсутствии аргумента.

## Когда использовать

- Сценарий 1.
- Сценарий 2.

## Влияние на производительность и память

Опишите влияние на RAM, VRAM, latency, throughput и startup time.

## Взаимодействие с другими аргументами

- `--related-argument`: как связан и какие комбинации важны.

## Типовые проблемы

- Симптом.
- Причина.
- Как диагностировать.
- Как исправить.

## Примеры

```bash
llama-server --argument-name value
```

## Что проверить агенту перед завершением

- Найти объявление аргумента в актуальном исходном коде llama.cpp.
- Проверить недавние PR/issues/discussions по аргументу.
- Запустить тестовый `llama-server` с аргументом и записать наблюдения.
- Добавить практические примеры и типовые ошибки.
- Обновить `summary` и `related`.

## Источники

- llama.cpp source/README:
- GitHub issues/PR/discussions:
- Локальные наблюдения:
