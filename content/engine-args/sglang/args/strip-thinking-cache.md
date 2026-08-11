---
schema: 1
engine: sglang
primaryName: "--strip-thinking-cache"
title: "--strip-thinking-cache"
summary: У reasoning-запроса в radix cache попадает только префикс промпта: KV размышления и ответа освобождается сразу по завершении. Меньше мусора в дереве префиксов ценой полного перерасчета, если клиент всё же продолжит диалог с этим ответом.
group: serving
related:
  - --reasoning-parser
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --enable-strict-thinking
  - --schedule-policy
  - --max-total-tokens
---

# --strip-thinking-cache

## Кратко

Обычно по завершении запроса SGLang вставляет в дерево префиксов весь его KV — промпт плюс сгенерированный текст, — чтобы продолжение диалога попало в кеш. У reasoning-моделей сгенерированный текст на 80–95% состоит из размышления, которое в следующий ход **не отправляется обратно**: клиенты выкидывают `reasoning_content` из истории.

Флаг убирает эту заведомо бесполезную часть: в дерево уходит только префикс промпта, остальные страницы KV освобождаются сразу.

Флаг помечен в справке как opt-in именно потому, что он меняет содержимое кеша, а не только его размер.

## Оригинальная справка

```text
Skip caching reasoning-model output (thinking + answer) in the radix tree on finish; keep only the prompt prefix. Opt-in: changes cache contents.
```

## Паспорт аргумента

- Флаги: `--strip-thinking-cache`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет
- Где объявлен: `ServerArgs.strip_thinking_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, явно помеченный как opt-in
- Этап применения: завершение запроса в планировщике — `release_kv_cache` / `cache_finished_req`

## Что меняет в движке

Точка решения — `Req.effective_kv_committed_len` (`sglang/python/sglang/srt/managers/schedule_batch.py`):

```python
def effective_kv_committed_len(self) -> int:
    # Report only the prompt prefix so thinking + answer fall into the
    # overallocated range and are reclaimed by release_kv_cache. #22373.
    if get_serving().strip_thinking_cache and self.reasoning_tokens > 0:
        return min(self.kv_committed_len, len(self.origin_input_ids))
    return self.kv_committed_len
```

Возвращенное значение используется дважды в `release_kv_cache` (`sglang/python/sglang/srt/mem_cache/common.py`): как `kv_len_to_handle` для `tree_cache.cache_finished_req` (сколько токенов вставить в дерево) и как левая граница диапазона `[effective, kv.kv_allocated_len]`, который затем освобождается функцией `_release_overallocated_kv_indices`. Там же снят инвариант:

```python
# strip_thinking_cache intentionally reports output tokens as overallocated
# so they fall into the free path below (#22373).
if spec_algo is None and not get_serving().strip_thinking_cache:
    assert start_p == end_p, ...
```

Два условия срабатывания, оба обязательны:

1. флаг включен;
2. `req.reasoning_tokens > 0`.

Второе условие — не «модель умеет думать», а «SGLang посчитал токены размышления у этого конкретного запроса». Счетчик ведет `Req.update_reasoning_tokens`, вызываемый из `batch_result_processor._maybe_update_reasoning_tokens` только когда `req.require_reasoning` истинно **и** `model_config.think_end_ids` непусто. А `think_end_ids` заполняется в конструкторе планировщика только при заданном `--reasoning-parser`. Итог: **без `--reasoning-parser` флаг не делает ничего**, тихо и без предупреждения.

`require_reasoning` для чат-запроса выводится из шаблона и `chat_template_kwargs` (`OpenAIServingChat._is_thinking_enabled_for_request`), так что запросы с выключенным thinking сохраняют обычное поведение кеша даже при включенном флаге.

Обратите внимание на выравнивание: освобождение идет с `ceil_align(start_p, page_size)`, поэтому при `--page-size > 1` последняя страница промпта может остаться занятой — это нормально.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» — вставляется весь KV запроса, как обычно.
- Гранулярности «резать только thinking, но оставить ответ» нет: граница ставится по длине входа, то есть отбрасывается и размышление, и финальный ответ.
- Пер-запросного переключателя нет.

## Когда использовать

- Reasoning-модель, много независимых запросов, длинные размышления, дерево префиксов быстро набивается мусором и вытесняет полезные системные префиксы. Признак — падающий `#cached-token` при стабильном наборе системных промптов.
- Дефицит KV-пула на инстансе с длинным thinking: освобождение хвоста сразу возвращает страницы в оборот, вместо того чтобы держать их до вытеснения.
- **Не включайте**, если клиент возвращает `reasoning_content` в истории следующего хода (некоторые агентские фреймворки так делают ради консистентности) — тогда вы сознательно ломаете попадание в кеш.
- **Не включайте** на многоходовых диалогах, где важно попадание на продолжение уже начатого ответа (`continue_final_message`, префилл ассистента).
- **Бесполезен** без `--reasoning-parser`.

## Влияние на производительность и память

- **KV-пул**: главный выигрыш. Страницы размышления возвращаются сразу после завершения запроса, а не ждут вытеснения по LRU. Под конкурентной нагрузкой это снижает число retraction'ов.
- **Дерево префиксов**: меньше узлов и меньше глубина, значит дешевле `match_prefix` и меньше памяти под сам индекс.
- **Prefill**: если продолжение диалога всё же приходит с историей, включающей ответ, оно теперь считается заново — прямой проигрыш. Это цена флага.
- На VRAM под весами, CUDA graph и скорость forward влияния нет.

## Взаимодействие с другими аргументами

- `--reasoning-parser`: обязательное условие работы (см. выше). Без него `think_end_ids` пуст, `reasoning_tokens` всегда 0 и ветка не срабатывает.
- `--disable-radix-cache`: с ним вставлять некуда, флаг теряет смысл.
- `--enable-hierarchical-cache`: отброшенный хвост не попадет и в host-уровень — экономия распространяется на оба уровня.
- `--schedule-policy lpm`: политика опирается на длину совпавшего префикса; отбрасывая ответы, вы делаете дерево «плоским» и повышаете предсказуемость её работы на однотипных промптах.
- `--enable-strict-thinking`: смежная тема (управление фазой размышления), но механизмы независимы: один фильтрует токены при генерации, другой распоряжается KV после нее.
- `--max-total-tokens` / `--mem-fraction-static`: чем теснее пул, тем заметнее эффект.
- Спекулятивное декодирование: инвариант `start_p == end_p` и так снят при активной спекуляции, так что комбинация корректна.

## Типовые проблемы и диагностика

- **Флаг включен, ничего не изменилось** — в 99% случаев не задан `--reasoning-parser`. Проверьте дамп `server_args=`: нужны оба.
- **`cached_tokens` упал на многоходовых диалогах** — ожидаемое следствие: продолжение больше не попадает в кеш на длину ответа. Если это критично, флаг не для вашей нагрузки.
- **Ожидали освобождения всей памяти запроса** — освобождается диапазон от длины входа до конца выделенного KV, с выравниванием вверх до границы страницы; сам промпт остается в дереве.
- Чем измерять: `#cached-token` и использование пула в строках `Prefill batch, …` / `Decode batch, …` планировщика, плюс метрики кеша при `--enable-metrics`. Отдельной подтверждающей строки в логе у этого флага нет — только значение в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --reasoning-parser qwen3 --strip-thinking-cache --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --reasoning-parser qwen3 --strip-thinking-cache --enable-cache-report --mem-fraction-static 0.85 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/mem_cache/common.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/batch_result_processor.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/parser/reasoning_parser.py`
