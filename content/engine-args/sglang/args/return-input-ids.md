---
schema: 1
engine: sglang
primaryName: "--return-input-ids"
title: "--return-input-ids"
summary: Добавляет токены входного промпта в расширение `sglext` каждого ответа chat completions. Удобно для аудита токенизации, но увеличивает размер ответа.
group: serving
related:
  - --return-output-ids
---

# --return-input-ids

## Кратко

Добавляет токены входного промпта в расширение `sglext` каждого ответа chat completions. Удобно для аудита токенизации, но увеличивает размер ответа.

## Оригинальная справка

```text
Return prompt (input) token ids on the response-level sglext extension for every chat completion request, as if return_input_ids_in_sglext were set on the request.
```

## Паспорт аргумента

- Флаги: `--return-input-ids`
- Группа: `serving`
- Тип: `bool`
- Значение в декларации по умолчанию: `false`
- Объявление: `ServerArgs.return_input_ids` в `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Обработчик chat completions считает этот серверный флаг эквивалентом `return_input_ids_in_sglext` в каждом запросе и включает `prompt_token_ids` в ответ.

## Значения и формат

Булев флаг, по умолчанию выключен. Поле возвращается в расширении `sglext` ответа, а не в стандартной части OpenAI-протокола.

## Когда использовать

Включайте для отладки шаблона чата и расхождений токенизации; для обычного serving оставляйте выключенным.

## Влияние на производительность и память

Списки token ID растут пропорционально длине промпта и увеличивают сетевой трафик и размер JSON. На KV-пул флаг не влияет.

## Взаимодействие с другими аргументами

Поклиентский `return_input_ids_in_sglext` также включает поле; серверный флаг распространяется на все запросы.

## Типовые проблемы и диагностика

Если поле отсутствует, проверьте, что запрос идёт в chat completions и клиент читает расширение `sglext`.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --return-input-ids
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
