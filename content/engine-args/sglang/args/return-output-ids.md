---
schema: 1
engine: sglang
primaryName: "--return-output-ids"
title: "--return-output-ids"
summary: Добавляет выбранные output token ID в расширение `sglext` каждого ответа chat completions. Используйте для диагностики генерации и сопоставления текста с токенами.
group: serving
related:
  - --return-input-ids
---

# --return-output-ids

## Кратко

Добавляет выбранные output token ID в расширение `sglext` каждого ответа chat completions. Используйте для диагностики генерации и сопоставления текста с токенами.

## Оригинальная справка

```text
Return sampled output token ids on the response-level sglext extension for every chat completion request, as if return_output_ids_in_sglext were set on the request.
```

## Паспорт аргумента

- Флаги: `--return-output-ids`
- Группа: `serving`
- Тип: `bool`
- Значение в декларации по умолчанию: `false`
- Объявление: `ServerArgs.return_output_ids` в `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

Обработчик chat completions считает этот серверный флаг эквивалентом `return_output_ids_in_sglext` в каждом запросе и собирает ID сгенерированных токенов для ответа.

## Значения и формат

Булев флаг, по умолчанию выключен. Данные находятся в расширении `sglext`, не в стандартном поле OpenAI-ответа.

## Когда использовать

Включайте при разборе расхождений между текстом ответа и последовательностью токенов.

## Влияние на производительность и память

Увеличивает размер ответа пропорционально длине генерации; KV-пул и веса модели не меняются.

## Взаимодействие с другими аргументами

Поклиентский `return_output_ids_in_sglext` также включает поле; серверный флаг действует на все chat completions.

## Типовые проблемы и диагностика

При отсутствии ID проверьте `sglext` в ответе и что запрос был chat completion, а не Responses API.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --return-output-ids
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/serving.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
