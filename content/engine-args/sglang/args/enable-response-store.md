---
schema: 1
engine: sglang
primaryName: "--enable-response-store"
title: "--enable-response-store"
summary: Включает хранение ответов Responses API в памяти процесса для повторного получения, цепочек и фоновых запросов. Хранилище не ограничено по времени и объёму.
group: serving
related:
  - --disaggregation-mode
---

# --enable-response-store

## Кратко

Включает хранение ответов Responses API в памяти процесса для повторного получения, цепочек и фоновых запросов. Хранилище не ограничено по времени и объёму.

## Оригинальная справка

```text
Enable in-memory Responses storage for retrieval, chaining, and background requests. Disabled by default; unsupported with prefill-decode disaggregation. Storage has no TTL or size limit.
```

## Паспорт аргумента

- Флаги: `--enable-response-store`
- Группа: `serving`
- Тип: `bool`
- Значение в декларации по умолчанию: `false`
- Объявление: `ServerArgs.enable_response_store` в `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Обработчик `/v1/responses` сохраняет ответы только для запросов с `store`; при выключенном флаге отвергает `previous_response_id` и `background`. Состояние находится в памяти процесса и исчезает при его перезапуске.

## Значения и формат

Булев флаг; по умолчанию выключен. В запросе отдельно требуется `store`, чтобы ответ попал в хранилище.

## Когда использовать

Включайте для клиентов, которые используют получение сохранённого ответа, `previous_response_id` или фоновые Responses-запросы.

## Влияние на производительность и память

Число и размер сохранённых ответов увеличивают RAM без встроенного TTL и лимита; учитывайте длительную работу сервера и объём трафика.

## Взаимодействие с другими аргументами

С `--disaggregation-mode prefill` или `decode` запуск запрещён: response store работает только в неделимом сервере.

## Типовые проблемы и диагностика

При PD-режиме `validate_response_store` останавливает старт. Если цепочка не работает, проверьте флаг и `store` в исходном запросе.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --enable-response-store
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/arg_groups/validation_hook.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_responses.py`
