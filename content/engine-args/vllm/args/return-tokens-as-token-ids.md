---
schema: 1
engine: vllm
primaryName: "--return-tokens-as-token-ids"
title: "--return-tokens-as-token-ids"
summary: Серверное значение по умолчанию для представления токенов в logprobs строками `token_id:<N>`. Спасает от невалидного UTF-8 в ответе; каждый запрос может переопределить.
group: Frontend
related:
  - --max-logprobs
  - --enable-prompt-tokens-details
  - --skip-tokenizer-init
---

# --return-tokens-as-token-ids

## Кратко

Часть токенов словаря — это байтовые фрагменты, не составляющие корректный UTF-8. Их декодированное представление в JSON приходится либо портить заменяющими символами, либо терять. Флаг заменяет строку токена на `token_id:<число>`, из которого клиент однозначно восстанавливает токен.

Флаг действует только там, где токены вообще выводятся: в `logprobs`. На обычный текст ответа он не влияет.

## Оригинальная справка

```text
When `--max-logprobs` is specified, represents single tokens as
strings of the form 'token_id:{token_id}' so that tokens that are not
JSON-encodable can be identified.
```

## Паспорт аргумента

- Флаги: `--return-tokens-as-token-ids`, `--no-return-tokens-as-token-ids`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: перебивается запросом — поле `return_tokens_as_token_ids` в теле `/v1/chat/completions` и `/v1/completions` имеет тип `bool | None`, и серверное значение применяется только при `None`
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.return_tokens_as_token_ids`
- Этап применения: HTTP-слой, сериализация logprobs в ответ

## Что меняет в движке

Значение раздается всем serving-классам генеративного роутера (`vllm/entrypoints/generate/api_router.py`), а также транскрипции/переводу и token-in-token-out. На запросе используется так:

```text
should_return_as_token_id = return_as_token_id if return_as_token_id is not None else self.return_tokens_as_token_ids
```

При истинном значении токен подставляется через `format_token_id_placeholder(token_id)` вместо `tokenizer.decode(...)`. Это касается и выбранного токена, и элементов `top_logprobs`.

Побочный, но важный эффект: при `skip_tokenizer_init=True` токенизатора нет, и путь с `tokenizer.decode` бросает `ValueError: Unable to get tokenizer because skip_tokenizer_init=True`. С этим флагом logprobs остаются доступны, потому что декодирование не нужно.

Обратное преобразование делает `resolve_token_id_placeholder` (`vllm/entrypoints/generate/base/serving.py`): она снимает префикс `token_id:` и подставляет представление токена из словаря; при отсутствии токена в словаре пишет одноразовое предупреждение.

## Значения и формат

- Включение: `--return-tokens-as-token-ids`. Выключение: `--no-return-tokens-as-token-ids`.
- «Не задан» = `false`.
- Формат строки в ответе фиксирован: `token_id:12345`. Поле `bytes` в logprobs при этом не заполняется декодированным представлением.
- Пер-запросное переопределение: `{"logprobs": true, "top_logprobs": 5, "return_tokens_as_token_ids": true}`. Значение `null` в запросе означает «взять серверное».
- Без `logprobs` в запросе флаг не проявляется никак.

## Когда использовать

- Клиент строит собственную аналитику по токенам (выравнивание, подсчет вероятностей, дообучение) и должен получать идентификаторы, а не их текстовое приближение.
- Модель с байтовым BPE и не-ASCII текстом: декодирование одиночных токенов дает «мусорные» строки, по которым нельзя восстановить исходный токен.
- Инстанс запущен с `--skip-tokenizer-init` — без флага запрос с `logprobs` завершится ошибкой про отсутствующий токенизатор.
- Не включайте на сервере, где logprobs читают люди или generic-инструменты: `token_id:15043` вместо `Hello` ломает любую наивную визуализацию.

## Влияние на производительность и память

Небольшой положительный эффект по CPU: пропускается декодирование каждого токена и каждого элемента `top_logprobs`. На VRAM, KV-cache и время старта не влияет. Размер ответа обычно немного растет — числовая форма длиннее короткого токена.

## Взаимодействие с другими аргументами

- `--max-logprobs`: задает верхнюю границу `top_logprobs`; без запроса logprobs этот флаг ничего не делает.
- `--skip-tokenizer-init`: делает флаг практически обязательным, если нужны logprobs.
- `--enable-prompt-tokens-details`: другой аргумент, расширяющий диагностическую часть ответа (usage), а не logprobs.

## Типовые проблемы и диагностика

- **Симптом:** в `logprobs` вместо текста строки `token_id:...`. **Причина:** флаг включен на сервере. **Лечение:** отключить флаг либо передать `"return_tokens_as_token_ids": false` в запросе.
- **Симптом:** `ValueError: Unable to get tokenizer because skip_tokenizer_init=True` на запросе с `logprobs`. **Причина:** декодирование токенов невозможно. **Лечение:** включить флаг.
- **Симптом:** клиент не может сопоставить токены logprobs с текстом ответа. **Причина:** декодированные одиночные токены не склеиваются в исходную строку побайтно. **Лечение:** включить флаг и восстанавливать текст по идентификаторам.
- **Симптом:** в логе предупреждение `resolve_token_id_placeholder: token_id <N> has no vocab entry`. **Причина:** идентификатор вне словаря токенизатора. **Проверка:** размер словаря модели и источник идентификатора.
- **Подтверждение принятого значения:** запрос с `"logprobs": true` — форма токенов в ответе видна сразу.

## Примеры

```bash
vllm serve /models/Qwen3-4B --return-tokens-as-token-ids --max-logprobs 20
```

```bash
vllm serve /models/Qwen3-4B --return-tokens-as-token-ids --skip-tokenizer-init
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/generate/base/serving.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/openai/completion/serving.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/vllm/entrypoints/generate/api_router.py`
