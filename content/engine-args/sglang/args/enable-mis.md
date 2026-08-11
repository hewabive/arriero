---
schema: 1
engine: sglang
primaryName: "--enable-mis"
title: "--enable-mis"
summary: Multi-Item Scoring: склеивает запрос и все кандидаты в одну последовательность с разделителями и считает их за один прогон, экономя повторный prefill запроса. Превращает сервер в специализированный скоринговый — принудительно выключает CUDA graph, radix cache и chunked prefill и требует backend внимания `flashinfer`.
group: exec.features
related:
  - --attention-backend
  - --prefill-attention-backend
  - --decode-attention-backend
  - --disable-radix-cache
  - --chunked-prefill-size
  - --disable-cuda-graph
  - --is-embedding
  - --max-running-requests
---

# --enable-mis

## Кратко

Скоринг «запрос против N кандидатов» наивно требует N прогонов, каждый из которых заново считает prefill одного и того же запроса. MIS собирает `query<delim>item1<delim>item2<delim>…` в одну последовательность и с помощью кастомной маски внимания FlashInfer добивается того, что каждый кандидат видит запрос, но не видит других кандидатов. Запрос считается один раз, кандидаты — параллельно. Цена высокая и уплачивается всем инстансом: `_handle_multi_item_scoring` выключает CUDA graph на обеих фазах, radix cache и chunked prefill, а несовместимый backend внимания приводит к падению на старте. Это конфигурация под эндпоинт `/v1/score`, а не флаг, который можно добавить к обычному чат-серверу.

## Оригинальная справка

```text
Enable Multi-Item Scoring optimization. Combines query and multiple items into a single sequence for efficient batch processing. Requires --attention-backend flashinfer; auto-disables CUDA graph, radix cache, and chunked prefill.
```

## Паспорт аргумента

- Флаги: `--enable-mis`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: само поле не переписывается, но оно **переписывает три других**. `_handle_multi_item_scoring` (`sglang/python/sglang/srt/server_args.py`) выставляет `cuda_graph_config.decode.backend = DISABLED` и `cuda_graph_config.prefill.backend = DISABLED`, `disable_radix_cache = True`, `chunked_prefill_size = -1`, каждое — с предупреждением вида `CUDA graph is disabled because --enable-mis is set.` Затем идет ассерт на backend внимания
- Где объявлен: `ServerArgs.enable_mis`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__`: `_handle_multi_item_scoring` **после** разрешения backend'а внимания и `chunked_prefill_size` → построение FlashInfer-backend'а → сборка последовательности в `/v1/score` → prefill

## Что меняет в движке

### Проверка на старте

Ассерт формулирует требование прямо:

```python
prefill_backend, decode_backend = self._resolved_attention_backends()
assert prefill_backend == "flashinfer" and decode_backend == "flashinfer", (
    "Multi-item scoring requires flashinfer attention backend for custom attention mask support. "
    f"Please set --attention-backend flashinfer when using --enable-mis. "
    f"Current backends: prefill={prefill_backend}, decode={decode_backend}"
)
```

Проверяются **разрешенные** значения, то есть результат всего автоподбора. Модель, для которой `_handle_model_specific_adjustments` навязывает свой backend, с MIS не совместима.

### Сборка последовательности

`tokenizer_manager_score_mixin.py` при включенном флаге токенизирует запрос и кандидаты по отдельности и склеивает их через `MIS_DELIMITER_TOKEN_ID` (константа `9999` в `server_args.py`). Позиции разделителей считаются по длинам кандидатов и передаются как `multi_item_delimiter_indices` — сам токен нужен только для совместимости с маской FlashInfer и для индексации колонок logprob'ов; в комментарии кода прямо сказано, что его уберут, когда backend научится работать по позициям.

### Внимание

`FlashInferAttnBackend` (`layers/attention/flashinfer_backend.py`) при `enable_mis`:

- принудительно отключает ragged-обертку на extend (`use_ragged = False`) — ragged не поддерживает специализированные параметры MIS и конфликтует с кастомной маской;
- строит `MultiItemScoringParams` из `multi_item_delimiter_indices` (`prefix_len_ptr`, `token_pos_in_items_ptr`, `max_item_len_ptr`) на каждом prefill'е;
- на фазе `DECODE` MIS не применяется — это чисто prefill-оптимизация.

### Logprob'ы

`logprob_result_processor.py` считает запрос MIS-запросом, если флаг включен, запрос prefill-only и у него есть `multi_item_delimiter_indices`. В этом режиме logprob'ы возвращаются только для позиций с разделителем — по одному числу на кандидата.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Не имеет смысла без обращений к `/v1/score`: обычные `/generate` и `/v1/chat/completions` его не используют, но платят за отключенные graph/radix/chunked prefill.
- `MIS_DELIMITER_TOKEN_ID = 9999` не настраивается. Если у вашей модели токен 9999 значим, помните, что он попадает во вход.
- Отключенный chunked prefill (`-1`) означает, что длина склеенной последовательности ограничена только `--context-length` и памятью.

## Когда использовать

- Выделенный инстанс-скорер: реранкинг, классификация по набору меток, отбор кандидатов. Один запрос — десятки кандидатов, каждый короткий.
- Не включайте на инстансе, обслуживающем генерацию: отключенные CUDA graph и radix cache бьют по TPOT и TTFT сильнее, чем MIS выигрывает на скоринге.
- Не включайте на модели, у которой backend внимания навязан архитектурой (DeepSeek DSA/V4, Llama4, Gemma4 и прочие ветки `_handle_model_specific_adjustments`): ассерт не даст стартовать.
- Не рассчитывайте, что MIS ускорит скоринг одного кандидата: выигрыш пропорционален числу кандидатов на один запрос.

## Влияние на производительность и память

- **Prefill.** Основной выигрыш: токены запроса считаются один раз вместо N. При длинном запросе и коротких кандидатах экономия близка к N-кратной.
- **VRAM.** Отключение CUDA graph освобождает память графов; отключение radix cache убирает дерево префиксов. Но отключение chunked prefill означает, что вся склеенная последовательность обрабатывается одним чанком — пик активаций растет с числом и длиной кандидатов.
- **TTFT/TPOT для генерации.** Ухудшаются: без CUDA graph decode идет в eager-режиме, без radix cache каждый повторный префикс считается заново.
- **Throughput скоринга.** Растет; предел определяется тем, какая склеенная последовательность помещается в один prefill-проход.
- **Время старта.** Немного уменьшается (нет захвата графов).

## Взаимодействие с другими аргументами

- `--attention-backend` / `--prefill-attention-backend` / `--decode-attention-backend`: разрешенные значения обоих фаз обязаны быть `flashinfer`.
- `--disable-radix-cache`: включается принудительно.
- `--chunked-prefill-size`: принудительно `-1`; ваше значение будет перезаписано с предупреждением.
- `--disable-cuda-graph` и семейство `--cuda-graph-backend-*`: обе фазы принудительно `disabled`.
- `--is-embedding`: другой способ поднять скоринговый сервер (модели-классификаторы через логиты класса); MIS — путь для causal-LM через logprob'ы.
- `--max-running-requests`, `--context-length`: ограничивают размер склеенной последовательности и число параллельных скоринговых запросов.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Multi-item scoring requires flashinfer attention backend …  Current backends: prefill=fa3, decode=fa3`. **Причина:** автоподбор выбрал не `flashinfer`. **Решение:** `--attention-backend flashinfer`, если модель это допускает.
- **Симптом:** после включения флага упал throughput генерации. **Причина:** отключены CUDA graph и radix cache. **Проверка:** предупреждения `CUDA graph is disabled because --enable-mis is set.`, `Radix cache is disabled because --enable-mis is set.`, `Chunked prefill is disabled because --enable-mis is set.` в логе старта.
- **Симптом:** OOM на длинном скоринговом запросе. **Причина:** chunked prefill выключен, последовательность идет одним чанком. **Решение:** уменьшить число кандидатов на запрос.
- **Симптом:** logprob'ы приходят не для всех позиций. **Причина:** штатное поведение MIS — по одному значению на кандидата, в позиции разделителя.
- **Что смотреть:** три предупреждения выше и итоговый дамп `server_args=`, где видно `chunked_prefill_size=-1` и `disable_radix_cache=True`.
- **В arriero:** отключенный radix cache и eager-decode делают такой инстанс существенно дороже по времени ответа; при политике вытеснения `idle-only` и разделяемой карте это заметно на соседних моделях. Заводите скоринговый инстанс отдельно от генеративного, а не переключайте один и тот же флагом.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --attention-backend flashinfer --enable-mis
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --attention-backend flashinfer --enable-mis --max-running-requests 16 --context-length 32768
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_backend.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager_score_mixin.py`
- `sglang/python/sglang/srt/managers/scheduler_components/logprob_result_processor.py`
- `sglang/python/sglang/srt/layers/logits_processor.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_info.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
