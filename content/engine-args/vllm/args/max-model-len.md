---
schema: 1
engine: vllm
primaryName: "--max-model-len"
title: "--max-model-len"
summary: Длина контекста инстанса (промпт плюс вывод) — одновременно верхняя граница запроса и цена одного запроса в KV-cache. Если не задать, движок выведет ее из конфига модели с учетом RoPE-масштабирования; `-1`/`auto` подбирает максимум, влезающий в память.
group: ModelConfig
related:
  - --gpu-memory-utilization
  - --kv-cache-memory-bytes
  - --kv-cache-dtype
  - --max-num-seqs
  - --max-num-batched-tokens
  - --num-gpu-blocks-override
  - --disable-sliding-window
  - --enable-chunked-prefill
---

# --max-model-len

## Кратко

`--max-model-len` задает единственное число, которым движок оперирует как «максимальная последовательность»: запросы длиннее отвергаются, а KV-cache планируется исходя из того, что один запрос может занять ровно столько токенов.

Это второй по важности аргумент после модели. Он не «резервирует» память сам по себе — память задает `--gpu-memory-utilization` (см. `content/engine-args/vllm/args/gpu-memory-utilization.md`), — но именно он превращает бюджет в число одновременных запросов: `Maximum concurrency ≈ размер KV-cache в токенах / max_model_len`.

## Оригинальная справка

```text
Model context length (prompt and output). If unspecified, will be
automatically derived from the model config.

When passing via `--max-model-len`, supports k/m/g/K/M/G in human-readable
format. Examples:

- 1k -> 1000
- 1K -> 1024
- 25.6k -> 25,600
- -1 or 'auto' -> Automatically choose the maximum model length that fits in
  GPU memory. This will use the model's maximum context length if it fits,
  otherwise it will find the largest length that can be accommodated.
```

## Паспорт аргумента

- Флаги: `--max-model-len`
- Группа argparse: `ModelConfig`
- Тип значения: int, но парсер — `human_readable_int_or_auto`: принимаются суффиксы `k/m/g/t` (десятичные) и `K/M/G/T` (двоичные), а также `-1` и `auto`
- Допустимые значения: `Field(default=None, ge=-1)` — минимум `-1`; после сборки конфига дополнительно требуется положительное целое
- Значение по умолчанию: `None`, то есть «вывести из конфига модели»
- Эффективное значение: почти всегда переопределяется. `ModelConfig.__post_init__` сохраняет исходное значение в `original_max_model_len` и вызывает `get_and_verify_max_len(...)`, который выводит длину из HF-конфига; при `-1`/`auto` окончательное значение выбирается уже после профилирования памяти в `_auto_fit_max_model_len` (`vllm/v1/core/kv_cache_utils.py`) и рассылается воркерам
- Где объявлен: `vllm/config/model.py:ModelConfig.max_model_len`
- Этап применения: разбор CLI → сборка `ModelConfig` (вывод и валидация длины) → профилирование памяти и выделение KV-cache (auto-fit и проверка вместимости) → планировщик и HTTP-слой (отказ слишком длинным запросам)

## Что меняет в движке

### Откуда берется значение, если аргумент не задан

Вся логика в `_get_and_verify_max_len` (`vllm/config/model.py`), по шагам:

1. База — `model_arch_config.derived_max_model_len_and_key`: первый найденный ключ длины в HF-конфиге (`max_position_embeddings` и родственные). Ключ запоминается и потом попадает в текст ошибки.
2. Если задан `--disable-sliding-window` и окно модели меньше базы, база заменяется на размер окна, а ключ — на `sliding_window`.
3. Для pooling-моделей с абсолютными позиционными эмбеддингами дополнительно учитывается `model_max_length` из `tokenizer_config.json`: берется минимум.
4. Если ни один ключ не найден, а значение не задано ни пользователем, ни целевой моделью спекулятивного декодирования, в лог идет предупреждение `The model's config.json does not contain any of the keys to determine the original maximum length of the model. Assuming the model's maximum length is 2048.`
5. RoPE-масштабирование. Для всех `rope_type`, кроме `su`, `longrope` и `llama3`, база умножается на `factor`; для `yarn` база сначала заменяется на `original_max_position_embeddings`. Модели `gemma3` пропускаются — у них длина в конфиге уже отмасштабирована. Если `factor` равен `null`, движок предупреждает `The model's RoPE configuration has a null scaling factor which is unexpected…` и берет 1.0.
6. Для sentence-transformers `encoder_config["max_seq_length"]` перебивает все предыдущее.
7. Если значение не задано или равно `-1`, берется полученная база (для `longrope` — `original_max_position_embeddings`, чтобы не портить качество на коротких последовательностях), затем платформенный хук `current_platform.check_max_model_len(...)`.

В лог итог пишется строкой `Using max model len N`.

### Что происходит, если значение задано вручную

Если запрошено больше выведенной базы, движок падает с `User-specified max_model_len (N) is greater than the derived max_model_len (<ключ>=D or model_max_length=M in model's config.json).` и подсказкой про `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1`. Исключение — когда в конфиге есть отдельный `model_max_length`, который не меньше запрошенного. Переменная окружения снимает запрет, но вместе с ним и корректность: сообщение прямо говорит, что при RoPE позиции за пределами базы дают `nan`, а при абсолютных эмбеддингах — выход за границы массива в CUDA.

Финальная проверка `validate_model_config_after` требует положительное целое: `max_model_len must be a positive integer, got …`.

### `-1` / `auto`

Значение `-1` доживает до выделения KV-cache в поле `original_max_model_len`. После профилирования `_auto_fit_max_model_len` бинарным поиском ищет максимальную длину, которая помещается в доступную память **на каждом** воркере, и берет минимум по воркерам:

- влезает полный контекст — `Auto-fit max_model_len: full model context length N fits in available GPU memory`;
- не влезает — `Auto-fit max_model_len: reduced from X to Y to fit in available GPU memory (Z GiB available for KV cache)`, и новое значение синхронизируется с воркерами (`vllm/v1/engine/core.py`);
- не влезает даже один токен — `Cannot auto-fit max_model_len: not enough GPU memory available to serve even a single token. Try increasing 'gpu_memory_utilization'.`;
- у модели без внимания (attention-free) auto-fit ничего не меняет и пишет `Auto-fit max_model_len: attention-free model, using derived max_model_len=N`.

## Значения и формат

- Обычное целое: `--max-model-len 8192`.
- Человеко-читаемые суффиксы: `1k` → 1000, `1K` → 1024, `25.6k` → 25 600, `32K` → 32 768. Дробное число с двоичным суффиксом отвергается парсером: `Decimals are not allowed with binary suffixes like K. Did you mean to use 25.6k instead?`
- `-1` и `auto` — одно и то же: подобрать максимум под доступную память.
- `0` и отрицательные значения, кроме `-1`, отвергаются (`ge=-1` плюс проверка на положительность после сборки конфига).
- Значение считается в токенах и покрывает промпт **и** вывод: `max_tokens` запроса ограничен остатком.

## Когда использовать

- Задавайте явно на управляемом сервере. Выведенная длина у современных моделей часто 128k–1M токенов; при `--gpu-memory-utilization` порядка 0.85 это означает concurrency меньше единицы и падение на старте.
- Ставьте значение по реальному профилю нагрузки, а не по максимуму модели: длина умножает цену запроса в KV-cache линейно.
- `-1`/`auto` уместен, когда важно «взять максимум, который поместится», и вас устраивает, что фактическая длина зависит от того, что еще занимало карту в момент старта. Для воспроизводимой конфигурации это плохой выбор.
- Не поднимайте выше выведенной базы через `VLLM_ALLOW_LONG_MAX_MODEL_LEN`, если модель не обучена на такую длину: это не «разблокировка контекста», а обход проверки.

## Влияние на производительность и память

- **VRAM.** Сам аргумент память не выделяет: бюджет задает `--gpu-memory-utilization`/`--kv-cache-memory-bytes`. Но именно он определяет, хватает ли бюджета хотя бы на один запрос, и сколько запросов помещается одновременно.
- **Throughput.** Число одновременных запросов = размер KV-cache в токенах / `max_model_len`. Уменьшение длины вдвое примерно вдвое увеличивает concurrency при том же бюджете.
- **Latency.** Косвенно: при низком concurrency растут вытеснения и повторные prefill.
- **Время старта.** При `-1`/`auto` добавляется бинарный поиск по уже собранным KV-cache-группам — это счет на модели, без повторного профилирования, вклад в старт незаметный.
- **Дефолты планировщика.** Если `--max-num-batched-tokens` не задан и chunked prefill выключен, движок поднимает его как минимум до `max_model_len`, а затем ограничивает произведением `max_num_seqs × max_model_len` (`_set_default_max_num_seqs_and_batched_tokens_args`). То есть длина контекста тянет за собой размер батча.

## Взаимодействие с другими аргументами

- `--gpu-memory-utilization`: задает бюджет в байтах, `--max-model-len` — цену одного запроса в этом бюджете. Разбор бюджета — в документе `--gpu-memory-utilization`.
- `--kv-cache-memory-bytes`: жестко задает размер KV-cache; при нем проверка вместимости считается от этого числа, а не от результата профилирования.
- `--kv-cache-dtype`: меняет байты на токен, то есть цену той же длины.
- `--max-num-seqs`, `--max-num-batched-tokens`: спрос планировщика; их дефолты зависят от `max_model_len` (см. выше).
- `--num-gpu-blocks-override`: подменяет число блоков; auto-fit и проверка вместимости пересчитывают доступную память под override (`get_kv_cache_configs`), поэтому обе ручки согласованы, но фактическая емкость перестает соответствовать бюджету.
- `--disable-sliding-window`: может понизить выведенную базу до размера окна.
- `--enable-chunked-prefill`: снимает требование «весь prefill в одном батче», из-за которого `--max-num-batched-tokens` подтягивался до `max_model_len`.

## Типовые проблемы и диагностика

- **Симптом:** `To serve at least one request with the model's max seq len (N), (X GiB KV cache is needed, which is larger than the available KV cache memory (Y GiB). Based on the available memory, the estimated maximum model length is M.` **Причина:** бюджета не хватает даже на один запрос заданной длины. **Лечение:** взять предложенное `M`, либо поднять `--gpu-memory-utilization`, либо перейти на квантованный `--kv-cache-dtype`.
- **Симптом:** `User-specified max_model_len (N) is greater than the derived max_model_len (max_position_embeddings=D or model_max_length=None in model's config.json).` **Причина:** запрошено больше, чем объявляет конфиг модели. **Лечение:** снизить значение; `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` — крайняя мера с проговоренными в сообщении последствиями.
- **Симптом:** старт прошел, но в логе длина не та, что вы задали. **Причина:** либо сработал auto-fit (`-1`/`auto`), либо длина выведена из конфига. **Проверка:** строки `Using max model len N` и `Auto-fit max_model_len: …`.
- **Симптом:** `Decimals are not allowed with binary suffixes like K. Did you mean to use 25.6k instead?` **Причина:** дробь с двоичным суффиксом (`25.6K`). **Лечение:** десятичный суффикс или целое число.
- **Симптом:** запросы отвергаются как слишком длинные, хотя промпт короче лимита. **Причина:** лимит покрывает промпт вместе с `max_tokens`. **Лечение:** уменьшить `max_tokens` в запросе или поднять длину контекста.
- **Симптом:** `Cannot auto-fit max_model_len: not enough GPU memory available to serve even a single token.` **Причина:** после весов и активаций бюджета под KV-cache не осталось. **Лечение:** поднять utilization, уменьшить `--max-num-batched-tokens`, добавить tensor parallel.
- **Подтверждение принятого значения:** `GPU KV cache size: N tokens, Maximum concurrency for M tokens per request: X.XXx` — здесь `M` и есть эффективный `max_model_len`.
- **Особенность arriero:** оценка памяти vLLM (`vllm-gpu-util`) считает draw только по `--gpu-memory-utilization`, tensor-parallel и `CUDA_VISIBLE_DEVICES`; `--max-model-len` попадает лишь в информационное поле контекста оценки. Увеличение длины контекста не меняет заявленный draw — оно меняет реальное concurrency внутри уже зарезервированного бюджета.

## Примеры

```bash
vllm serve /models/Qwen3-4B --max-model-len 8192 --gpu-memory-utilization 0.85 --max-num-seqs 2
```

```bash
vllm serve /models/Qwen3-4B --max-model-len auto --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/docs/configuration/optimization.md`
- `docs/MEMORY_ESTIMATION.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
