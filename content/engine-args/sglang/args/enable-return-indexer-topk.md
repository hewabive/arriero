---
schema: 1
engine: sglang
primaryName: "--enable-return-indexer-topk"
title: "--enable-return-indexer-topk"
summary: Возвращает индексы токенов, которые выбрал разреженный индексатор внимания (DSA/DeepSeek-V3.2 и родственные) на каждом слое. Работает только на CUDA и только при `attn_tp_size == 1`; в OpenAI-схеме отдельного поля нет, значение приходит в `meta_info`.
group: exec.features
related:
  - --enable-return-routed-experts
  - --enable-return-hidden-states
  - --attention-backend
  - --dsa-topk-backend
  - --enable-dp-attention
  - --tp-size
  - --chunked-prefill-size
  - --max-running-requests
---

# --enable-return-indexer-topk

## Кратко

У архитектур с разреженным вниманием (DeepSeek DSA и совместимые) на каждом слое с индексатором выбирается `index_topk` позиций KV, к которым внимание вообще обращается. Флаг включает захват этих индексов и отдает их клиенту base64-строкой из int32. Механика повторяет `--enable-return-routed-experts`: тот же `BaseTopkCapturer`, тот же GPU-буфер плюс закрепленный host-буфер размером с KV-пул. Два жестких ограничения делают флаг узким: захват реализован только для CUDA и только при `attn_tp_size == 1`, то есть на практике — в конфигурации с DP-attention.

## Оригинальная справка

```text
Enable returning indexer topk indices of layers with indexer with responses.
```

## Паспорт аргумента

- Флаги: `--enable-return-indexer-topk`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: поле не переписывается, но capturer может не создаться. На не-CUDA устройстве `create_indexer_capturer` печатает `indexer-topk capture is CUDA-only; <device> backend not yet wired. Disabling capturer.` и возвращает `None`. Если у модели нет слоев с индексатором, печатается `No indexer layers found, IndexerTopkCapturer disabled`. Если `attn_tp_size != 1`, конструктор падает ассертом `IndexerTopkCapturer now only supports DP attention`
- Где объявлен: `ServerArgs.enable_return_indexer_topk`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `ModelRunner.init_indexer_capturer` (выделение буферов) → `maybe_capture_indexer_topk` внутри индексатора на каждом форварде → копирование device→host в конце форварда → `meta_info` ответа

## Что меняет в движке

### Буферы

`IndexerTopkCapturer` (`state_capturer/indexer_topk.py`) наследует `BaseTopkCapturer` и выделяет два тензора `int32`:

- **device cache** формы `(max_batch_size, num_indexer_layers, index_topk)`, где `max_batch_size = max(chunked_prefill_size, max_running_requests)` — без множителя `dp_size`, потому что при DP-attention каждый ранг пишет только свой локальный батч;
- **host cache** формы `(num_tokens, num_indexer_layers, index_topk)` в закрепленной памяти хоста, `num_tokens = max_token_pool_size + page_size`.

Оба размера печатаются при старте (`DeviceCache[indexer_topk] allocated: …`, `HostCache[indexer_topk] allocated: …`). Обратите внимание на масштаб: `index_topk` у DSA-моделей — это сотни (в отличие от `topk` MoE-роутера, где счет идет на единицы), поэтому host-буфер здесь на порядок-другой больше, чем у `--enable-return-routed-experts` при том же пуле. Считайте до старта: `num_tokens × num_indexer_layers × index_topk × 4` байт закрепленной RAM.

Число слоев берется из `get_num_indexer_layers(hf_text_config)`, `index_topk` — из атрибута `index_topk` конфига модели (по умолчанию `0`).

### Захват

`maybe_capture_indexer_topk(layer_id, topk_indices)` вызывается из индексатора и пропускает тензор насквозь, попутно записывая его в device cache. Комментарий в коде фиксирует, что продюсеры подключены только на CUDA-пути (`Indexer.forward_cuda` и MLA skip-topk), поэтому на других backend'ах capturer был бы создан, но никогда не заполнен — отсюда явное отключение по устройству.

В конце форварда `on_forward_end` копирует срез `[0:num_tokens]` device cache в host cache по `out_cache_loc` — синхронно либо через поток результатов в overlap-режиме.

### Что видит клиент

Запрос: `return_indexer_topk: true` в теле нативного `/generate`. Ответ: `meta_info["indexer_topk"]` — base64 от сырых int32 (`managers/tokenizer_manager.py`); клиент решейпит в `(seqlen − 1, num_indexer_layers, index_topk)`, вспомогательная функция `extract_indexer_topk_from_meta_info` лежит рядом с capturer'ом.

**Отдельного поля в OpenAI-схеме нет.** В отличие от `routed_experts`, которые попадают в `sglext`, индексы индексатора через `/v1/chat/completions` и `/v1/completions` не выдаются: ни `CompletionRequest`, ни `ChatCompletionRequest` не объявляют `return_indexer_topk`. Единственный обходной путь на OpenAI-фасаде — непотоковый chat-запрос с `return_meta_info: true`, который кладет весь `meta_info` в `choices[i].meta_info`; сам захват при этом все равно нужно включать этим флагом, а поле запроса передавать нативным API.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Осмыслен только для моделей с индексатором (DSA-семейство). На обычной модели capturer не создается, буферы не выделяются, в лог идет `No indexer layers found`.
- Требует `attn_tp_size == 1` — то есть либо `--tp-size 1`, либо DP-attention, где attention-TP-группа вырождена.
- Требует CUDA.

## Когда использовать

- Исследование разреженного внимания: на какие позиции реально смотрит модель, как меняется покрытие с длиной контекста, сравнение реализаций индексатора.
- Отладка выбора `--dsa-topk-backend`: сравнить индексы, полученные разными реализациями, на одном и том же входе.
- Не включайте на боевом инстансе: закрепленный host-буфер под `index_topk` в сотни элементов на слой и на токен — это самая дорогая по хостовой памяти опция из всей группы `return-*`.
- Не включайте на не-DSA модели: буферов не будет, но и пользы тоже.
- Не рассчитывайте получить индексы через OpenAI-совместимый эндпоинт обычным способом.

## Влияние на производительность и память

- **RAM хоста.** `num_tokens × num_indexer_layers × index_topk × 4` байт закрепленной памяти. При пуле на 100 000 токенов, 60 слоях и `index_topk` 2048 это уже десятки гигабайт — считайте до включения флага.
- **VRAM.** Device cache `max_batch_size × num_indexer_layers × index_topk × 4` байт; уменьшает `max_total_num_tokens`.
- **Latency.** Запись индексов на каждом слое с индексатором плюс D2H-копирование в конце форварда.
- **Throughput.** Падает пропорционально числу слоев и размеру `index_topk`.
- **Размер ответа.** `(seqlen − 1) × num_indexer_layers × index_topk × 4` байт до base64. Это самый «толстый» из всех `return-*`-выводов.

## Взаимодействие с другими аргументами

- `--enable-dp-attention` и `--tp-size`: определяют `attn_tp_size`; при значении больше 1 конструктор падает ассертом.
- `--attention-backend`: индексатор существует только на DSA-путях (`dsa`, `dsv4` и их архитектурные переопределения).
- `--dsa-topk-backend`: определяет реализацию, чьи индексы вы захватываете.
- `--chunked-prefill-size`, `--max-running-requests`: задают первую размерность device cache.
- `--mem-fraction-static` (косвенно): через `max_token_pool_size` задает размер host cache.
- `--enable-return-routed-experts`: независимый флаг с той же механикой; включенные вместе они дают два host-буфера.
- `--enable-return-hidden-states` / `--return-hidden-states-mode`: третье независимое расширение ответа.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: IndexerTopkCapturer now only supports DP attention`. **Причина:** `attn_tp_size > 1`. **Решение:** включить `--enable-dp-attention` или снизить `--tp-size`.
- **Симптом:** предупреждение `indexer-topk capture is CUDA-only; … backend not yet wired.` **Причина:** запуск не на CUDA. **Решение:** убрать флаг.
- **Симптом:** `No indexer layers found, IndexerTopkCapturer disabled`. **Причина:** модель без индексатора.
- **Симптом:** хост ушел в swap сразу после старта. **Причина:** закрепленный host cache. **Проверка:** строка `HostCache[indexer_topk] allocated: shape=…, size=… GB` при старте.
- **Симптом:** в ответе `/v1/chat/completions` нет индексов. **Причина:** поля в OpenAI-схеме нет; используйте нативный `/generate` либо `return_meta_info: true` без стриминга.
- **Что смотреть:** обе строки `DeviceCache[indexer_topk] …` / `HostCache[indexer_topk] …`, итоговый дамп `server_args=`.
- **В arriero:** прокси пробрасывает тело запроса как есть, поэтому `return_indexer_topk` в теле дойдет до SGLang; ответ так же возвращается потоком без изменений. Но на Anthropic-фасаде мост пересобирает тело из фиксированных полей, и `meta_info` теряется — для этого сценария пользуйтесь фасадом `/v1/*`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-return-indexer-topk
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2 --enable-return-indexer-topk --max-running-requests 8 --chunked-prefill-size 4096
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/state_capturer/base.py`
- `sglang/python/sglang/srt/state_capturer/indexer_topk.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/managers/detokenizer_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- arriero: `apps/api/src/proxy/forwarder.ts`, `packages/anthropic-openai-bridge/src/response.ts`
