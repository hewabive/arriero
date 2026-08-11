---
schema: 1
engine: vllm
primaryName: "--enable-prompt-embeds"
title: "--enable-prompt-embeds"
summary: Разрешает клиентам подавать на вход готовые эмбеддинги вместо текста. Обходит токенизатор и чат-шаблон целиком, поэтому включается только для доверенных клиентов.
group: ModelConfig
related:
  - --enable-prefix-caching
  - --skip-tokenizer-init
  - --max-model-len
  - --dtype
  - --speculative-config
---

# --enable-prompt-embeds

## Кратко

С этим флагом запрос может содержать поле `prompt_embeds` — base64-упакованный `torch.Tensor` формы `(num_tokens, hidden_size)`, который движок вставляет прямо в вход модели вместо эмбеддингов, полученных из токенов.

Валидация формы, типа и размерности выполняется на входе, поэтому «крэш от неправильной формы» из справки сегодня закрыт проверками. Остаётся содержательный риск: эмбеддинги не проходят ни токенизацию, ни чат-шаблон, ни какие-либо ограничения в пространстве словаря. Клиент задаёт вход модели напрямую.

## Оригинальная справка

```text
If `True`, enables passing text embeddings as inputs via the
`prompt_embeds` key.

WARNING: The vLLM engine may crash if incorrect shape of embeddings is passed.
Only enable this flag for trusted users!
```

## Паспорт аргумента

- Флаги: `--enable-prompt-embeds`, `--no-enable-prompt-embeds`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-prompt-embeds` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется; но при `True` инстанс становится несовместим с model runner V2 (попадает в `_get_v2_model_runner_unsupported_features`)
- Где объявлен: `vllm/config/model.py:ModelConfig.enable_prompt_embeds`
- Этап применения: HTTP-слой (парсинг запроса и рендеринг) → планировщик (хеширование блоков) → model runner (подстановка `inputs_embeds`)

## Что меняет в движке

**Ворота на входе.** Флаг проверяется в четырёх местах, и все они отказывают одинаково при выключенном флаге:

- `vllm/renderers/embed_utils.py:safe_load_prompt_embeds` — `VLLMValidationError("You must set --enable-prompt-embeds to input prompt_embeds.", parameter="prompt_embeds")`;
- `vllm/renderers/base.py:_process_embeds` — `ValueError` с тем же текстом;
- `chat_utils.py:parse_prompt_embeds` (синхронный и асинхронный парсер контента);
- `renderers/hf.py` и `online_renderer.py` — при сборке смешанного промпта.

**Что именно проверяется** в `safe_load_prompt_embeds`:

1. `torch.load(BytesIO(pybase64.b64decode(embed, validate=True)), weights_only=True, map_location="cpu")` — `weights_only=True` означает, что произвольный pickle не исполняется;
2. результат обязан быть `torch.Tensor`, иначе `VLLMValidationError`;
3. `to_dense()`, затем схлопывание лишней batch-размерности; итог обязан быть 2D, иначе ошибка с указанием фактической формы;
4. `tensor.shape[1]` обязан совпасть с `model_config.get_hidden_size()`;
5. dtype обязан быть плавающим и приводится к `model_config.dtype` — «so API clients don't need to know the server's `--dtype` setting ahead of time».

**Рендеринг.** Каждый `prompt_embeds`-фрагмент в чате превращается в один служебный токен `PROMPT_EMBEDS_PLACEHOLDER_TOKEN`, который потом разворачивается в `tensor.shape[0]` плейсхолдеров. Семантика эндпоинтов разная и описана в `vllm/docs/features/prompt_embeds.md`: `/v1/completions` **не** применяет чат-шаблон (клиент обязан сам подать уже отшаблоненный вход), а `/v1/chat/completions` оборачивает шаблон вокруг вашего фрагмента — вкладывать туда целый шаблонизированный диалог нельзя, шаблон применится дважды.

**Исполнение.** `GPUModelRunner` держит `self.enable_prompt_embeds` и на каждом шаге выбирает путь `inputs_embeds` вместо `input_ids`; на не-первом ранге pipeline-параллелизма поведение отдельное.

**Prefix caching.** `vllm/v1/core/kv_cache_utils.py:_gen_prompt_embeds_extra_hash_keys` добавляет в хеш блока `sha256` от байтов соответствующего среза эмбеддингов (с кэшированием по диапазону блока). То есть запросы с эмбеддингами кэшируются корректно, но каждый новый блок стоит одного sha256 по своим байтам.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False` = поле `prompt_embeds` отвергается.
- Формат полезной нагрузки задаётся не этим флагом, а API: base64 от `torch.save` тензора `(num_tokens, hidden_size)`. Тензор `(1, num_tokens, hidden_size)` принимается — batch-размерность схлопывается.
- Целочисленные, булевы и комплексные тензоры отвергаются намеренно: «integer / bool / complex inputs almost certainly indicate caller error».
- В чат-запросе фрагмент выглядит как `{"type": "prompt_embeds", "data": "<base64>"}` и может стоять в любом месте среди текстовых частей.

## Когда использовать

- Клиент считает эмбеддинги сам (soft prompts, обученные префиксы, проекции из другой модальности) и подаёт их напрямую.
- Исследовательский стенд, где нужен доступ к пространству эмбеддингов, а не к токенам.
- **Не включайте на инстансе с недоверенными клиентами.** Любая фильтрация, завязанная на текст запроса — в том числе на стороне прокси arriero, — обходится: содержимое `prompt_embeds` для неё непрозрачно, там нет текста.
- Не включайте «на будущее»: флаг переводит инстанс в набор несовместимостей (V2 runner) без всякой пользы, пока эмбеддинги не используются.

## Влияние на производительность и память

- **Трафик и хостовая RAM.** Один запрос несёт `num_tokens × hidden_size × байт_на_элемент` в теле HTTP, плюс ~4/3 сверху за base64. Для 1000 токенов при hidden 4096 в BF16 это ~8 MiB сырых и ~11 MiB в теле запроса.
- **CPU хоста.** base64-декод и `torch.load` вынесены в пул потоков (`safe_load_prompt_embeds_async`), чтобы не блокировать event loop, но нагрузка остаётся.
- **VRAM.** Эмбеддинги копируются на устройство как обычный вход; KV-cache расходуется по числу токенов, как для текста той же длины.
- **Prefix caching.** Дополнительный sha256 по байтам каждого блока при хешировании — заметно на длинных эмбеддинг-промптах.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: работает и с эмбеддингами (хеш блока учитывает их байты), но попадание возможно только при побайтово совпадающем префиксе.
- `--skip-tokenizer-init`: соседний способ обойти токенизатор — там клиент подаёт готовые `prompt_token_ids`. Это разные входы и разные флаги.
- `--dtype`: определяет тип, к которому приводится присланный тензор; клиенту знать его не обязательно.
- `--max-model-len`: длина считается в токенах-плейсхолдерах, то есть по `tensor.shape[0]`.
- `--speculative-config`: по таблице совместимости апстрима prompt-embeds и speculative decoding вместе не поддержаны (`vllm/docs/features/README.md`).

## Типовые проблемы и диагностика

- **Симптом:** `You must set --enable-prompt-embeds to input prompt_embeds.` **Причина:** флаг не задан. **Лечение:** добавить флаг и перезапустить инстанс.
- **Симптом:** ``prompt_embeds` hidden_size 2048 does not match the model's hidden_size 4096.` **Причина:** эмбеддинги посчитаны другой моделью. **Лечение:** пересчитать той же моделью, что обслуживает инстанс.
- **Симптом:** ``prompt_embeds` must be a 2D tensor of shape (num_tokens, hidden_size); got shape (2, 10, 4096).` **Причина:** батч больше единицы. **Лечение:** слать по одному примеру на запрос.
- **Симптом:** ``prompt_embeds` dtype torch.int8 is not a floating-point type, cannot safely cast to the model's dtype torch.bfloat16.` **Причина:** прислан квантованный или не тот тензор.
- **Симптом:** ответ выглядит так, будто шаблон применён дважды. **Причина:** в чат-эндпоинт отправлен уже шаблонизированный диалог. **Лечение:** в чат — только содержимое, в `/v1/completions` — весь шаблонизированный вход.
- **Подтверждение принятого значения:** отдельной строки нет; проверяется запросом с `prompt_embeds`, который перестаёт отвергаться.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-prompt-embeds --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --enable-prompt-embeds --enable-prefix-caching --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/renderers/embed_utils.py`
- `vllm/vllm/renderers/base.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/config/vllm.py`
- `vllm/docs/features/prompt_embeds.md`
- `vllm/docs/features/README.md`
