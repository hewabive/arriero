---
schema: 1
engine: sglang
primaryName: "--allow-auto-truncate"
title: "--allow-auto-truncate"
summary: Вместо ошибки «input too long» сервер молча обрезает вход (а при нехватке места — и `max_new_tokens`) до влезающего размера. Обрезается **хвост** промпта, что для чата означает потерю последнего сообщения пользователя.
group: serving
related:
  - --context-length
  - --max-total-tokens
  - --mem-fraction-static
  - --speculative-num-draft-tokens
  - --log-requests
---

# --allow-auto-truncate

## Кратко

Флаг превращает три отказа в три тихих усечения. Он удобен для нагрузочных прогонов и для клиентов, которые не умеют считать токены, и опасен в проде: усечение не сообщается клиенту ни статусом, ни полем ответа — только предупреждением в логе сервера.

Обрезка всегда идет **справа**: `input_ids[:limit]`. Для чат-промпта, где системная инструкция в начале, а свежий вопрос и `add_generation_prompt` в конце, это означает, что модель получит начало диалога без самого вопроса.

## Оригинальная справка

```text
Allow automatically truncating requests that exceed the maximum input length instead of returning an error.
```

## Паспорт аргумента

- Флаги: `--allow-auto-truncate`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет
- Где объявлен: `ServerArgs.allow_auto_truncate`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: валидация запроса в `TokenizerManager` → валидация запроса в планировщике → дополнительно проверка `max_completion_tokens` в OpenAI-фасаде чата

## Что меняет в движке

Флаг читают три независимые проверки, и они срабатывают в разном порядке для разных путей.

### 1. `TokenizerManager._validate_one_request` — против `context_len`

```python
input_token_num = len(input_ids) + self.num_reserved_tokens
if input_token_num >= self.context_len:
    if self.allow_auto_truncate:
        logger.warning(... "Truncating the input.")
        del input_ids[_max_req_len:]
    else:
        raise ValueError(f"The input ({input_token_num} tokens) is longer than the model's context length ({self.context_len} tokens).")
```

`num_reserved_tokens` не ноль только для eagle-спекуляции (`compute_num_reserved_tokens`, `sglang/python/sglang/srt/managers/utils.py`) — тогда бюджет контекста дополнительно уменьшается на draft-токены.

Следом идет вторая проверка того же метода — суммарная:

```python
if self.validate_total_tokens and max_new_tokens is not None and (max_new_tokens + input_token_num) > _max_req_len:
    if self.allow_auto_truncate:
        obj.sampling_params["max_new_tokens"] = max(0, _max_req_len - input_token_num)
    else:
        raise ValueError("Requested token count exceeds the model's maximum context length …")
```

То есть с флагом урезается **не только вход, но и запрошенная длина генерации**, вплоть до нуля.

### 2. Планировщик — против фактического KV-пула

`validate_input_length` (`sglang/python/sglang/srt/managers/utils.py`), вызывается из `Scheduler` для generate- и embedding-запросов:

```python
if len(req.origin_input_ids) >= max_req_input_len:
    if allow_auto_truncate:
        logger.warning("Request length is longer than the KV cache pool size or the max context length. Truncated. …")
        req.origin_input_ids = req.origin_input_ids[:max_req_input_len]
        return None
    else:
        return (f"Input length ({len(req.origin_input_ids)} tokens) exceeds the maximum allowed length "
                f"({max_req_input_len} tokens). Use a shorter input or enable --allow-auto-truncate.")
```

`max_req_input_len` — это `min(context_len, размер KV-пула) - 6` (см. `--context-length`), поэтому эта проверка может сработать даже тогда, когда первая прошла: пул меньше объявленного контекста.

### 3. OpenAI-фасад чата — против `max_completion_tokens`

`OpenAIServingChat._validate_request`:

```python
if (max_output_tokens and server_context_length and max_output_tokens > server_context_length) \
        and not self.tokenizer_manager.server_args.allow_auto_truncate:
    return f"max_completion_tokens is too large: {max_output_tokens}. This model supports at most {server_context_length} completion tokens."
```

Обратите внимание: сравнение идет с `server_args.context_length`, то есть с **явно заданным** аргументом. Если `--context-length` не задан (`None`), проверка не выполняется вовсе, независимо от флага.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — строгий режим: клиент получает 400 с текстом об избыточной длине.
- Частичных режимов (обрезать вход, но не `max_new_tokens`; обрезать слева) нет.
- Никакого поля в ответе, сигнализирующего об усечении, не добавляется. Единственный след — WARNING в логе сервера.

## Когда использовать

- Нагрузочное тестирование и бенчмарки с синтетическими промптами произвольной длины: отказы ломают прогон, усечение — нет.
- Пакетная обработка «сделай что сможешь» (классификация, эмбеддинги), где обрезанный документ лучше пропущенного.
- Клиент физически не может посчитать токены заранее (чужой токенизатор, прокси без доступа к модели), а деградация допустима.
- **Не включайте** в интерактивном чате и в агентских пайплайнах: молча потерянный хвост промпта выглядит как «модель отвечает не на то» и не диагностируется со стороны клиента.
- **Не используйте** как замену настройке ёмкости: если усечения происходят регулярно, чинить надо `--context-length`, `--mem-fraction-static` и `--max-total-tokens`.

## Влияние на производительность и память

На VRAM, KV-пул и скорость не влияет: флаг меняет решение «отказать или урезать», а не размеры структур. Косвенно — усеченный запрос дешевле полного, поэтому под перегрузкой включенный флаг снижает среднюю стоимость запроса ценой качества ответа.

## Взаимодействие с другими аргументами

- `--context-length`: задает верхнюю границу первой проверки и участвует в третьей. Не заданный `--context-length` отключает проверку `max_completion_tokens` целиком.
- `--max-total-tokens` и `--mem-fraction-static`: определяют реальный размер KV-пула, а значит и `max_req_input_len` во второй проверке. Именно она чаще всего срабатывает на практике — «контекст 128k, а отказ на 60k».
- `--speculative-num-draft-tokens` и eagle-спекуляция: увеличивают `num_reserved_tokens` и, следовательно, снижают порог первой проверки.
- `--log-requests`: единственный способ соотнести усечение с конкретным запросом, кроме поиска по WARNING'ам.

## Типовые проблемы и диагностика

- `The input (N tokens) is longer than the model's context length (M tokens).` — первая проверка, флаг выключен.
- `Input length (N tokens) exceeds the maximum allowed length (M tokens). Use a shorter input or enable --allow-auto-truncate.` — вторая проверка (упёрлись в KV-пул). Если `M` заметно меньше `--context-length`, увеличивать надо пул, а не контекст.
- `Requested token count exceeds the model's maximum context length …` — сумма входа и `max_tokens` не влезает.
- `max_completion_tokens is too large: N. This model supports at most M completion tokens.` — третья проверка; заметьте, что она сравнивает длину **вывода** с полной длиной контекста.
- **С флагом ответы стали короткими или пустыми** — сработала обрезка `max_new_tokens` до `max(0, limit - input)`. В логе: `Requested token count (… input + … new) exceeds the model's context length … Truncating max_new_tokens.`
- **Модель игнорирует последний вопрос** — усечен хвост промпта. В логе: `Truncating the input.` или `Request length is longer than the KV cache pool size or the max context length. Truncated.`
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --allow-auto-truncate --context-length 32Ki --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --allow-auto-truncate --log-requests --log-requests-level 1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/utils.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
