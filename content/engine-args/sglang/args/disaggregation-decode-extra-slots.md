---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-extra-slots"
title: "--disaggregation-decode-extra-slots"
summary: Сколько дополнительных строк `req_to_token` decode-сервер держит под запросы, чей KV еще едет от prefill. Не задан — движок подставляет `0` либо `2 × размер батча на воркер`, если тот не больше 32.
group: disagg
related:
  - --disaggregation-mode
  - --max-running-requests
  - --dp-size
  - --num-reserved-decode-tokens
  - --disaggregation-decode-polling-interval
  - --context-length
  - --mem-fraction-static
  - --page-size
---

# --disaggregation-decode-extra-slots

## Кратко

На decode-сервере запрос занимает строку пула `req_to_token` задолго до того, как начнет генерировать: сначала он предвыделяет место под входящий KV, потом ждет передачи от prefill. Если пул строк рассчитан ровно на `--max-running-requests`, то запросы «в пути» отъедают места у уже работающих, и конвейер перестает перекрываться. Этот аргумент добавляет строки сверх `max_running_requests` специально под них. Задавать его нужно только тогда, когда авто-значение (`0` для больших батчей) вас не устраивает.

## Оригинальная справка

```text
Number of extra decode req_to_token slots pre-allocated for in-transfer requests (PD mode). If unset, defaults to 0 (or 2x the per-worker running batch for small batches).
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-extra-slots`
- Группа: `disagg`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `choices` нет; осмысленны целые ≥ 0
- Значение по умолчанию: `null` (не задан)
- Эффективное значение: при `--disaggregation-mode decode` и незаданном значении `handle_pd_disaggregation` подставляет число: `0`, если `--max-running-requests` не задан или если `max_running_requests // max(1, dp_size) > 32`; иначе `2 * (max_running_requests // dp_size)`. Вне режима `decode` поле остается `None` и всюду читается как `0`
- Где объявлен: `ServerArgs.disaggregation_decode_extra_slots`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_pd_disaggregation` (подстановка авто-значения) → `model_executor/pool_configurator.py` и `mem_cache/kv_cache_configurator.py` при расчете размеров пулов → построение `DecodeReqToTokenPool`

## Что меняет в движке

Значение — это `pre_alloc_size` пула строк на decode-стороне:

- `_build_req_to_token_pool` при `--disaggregation-mode decode` строит `DecodeReqToTokenPool` (или гибридный mamba-вариант) с `pre_alloc_size = disaggregation_decode_extra_slots`. Обычный `ReqToTokenPool` держит инвариант «предвыделенные + в передаче + работающие ≤ `--max-running-requests`»; decode-вариант существует ровно для того, чтобы этот инвариант ослабить.
- `_get_num_req_slots` в конфигураторе пулов возвращает `max_running_requests + disaggregation_decode_extra_slots + 1` вместо `max_running_requests + 1`.
- Для SWA-моделей вклад учитывается и в токенах: `_swa_cap` добавляет `(window + page_size) * disaggregation_decode_extra_slots`.
- В `kv_cache_configurator` то же число уходит как `decode_pre_alloc_size` (для режимов, отличных от `decode`, там жестко подставляется `0`).

Каждая дополнительная строка — это `extra_max_context_len` элементов индекса токенов, то есть память масштабируется с `--context-length`, а не только с числом слотов.

## Значения и формат

- Целое ≥ 0. `0` означает «дополнительных строк нет» — ровно то же, что авто-значение для больших батчей.
- `null` (не задан) — не то же самое, что `0` для больших батчей: при `--max-running-requests`, дающем на воркер не больше 32, вы получите `2 × per_worker` вместо нуля.
- Формула авто-значения делит на `--dp-size`, а не на `attn_dp_size`, — то есть на объявленный размер data parallelism.
- Вне `--disaggregation-mode decode` значение остается `None` и трактуется как `0`: аргумент на prefill и на монолитном сервере бессмыслен.
- Верхней проверки нет: слишком большое значение просто уменьшит KV-пул, потому что строки индексов делят ту же VRAM.

## Когда использовать

- Большой `--max-running-requests` (на воркер больше 32) и заметная доля времени, которую запросы проводят в состоянии передачи: авто-значение здесь `0`, и конвейер приема упирается в число строк. Начните с `max_running_requests // dp_size // 4`.
- Медленная сеть или большой `--disaggregation-decode-polling-interval`: запросы дольше висят «в пути», строк надо больше.
- Не поднимайте, если очередь передачи и так пуста: строки — это чистая трата VRAM под индексы.
- Не используйте как замену `--max-running-requests`: дополнительные строки не увеличивают конкурентность генерации, только глубину приемного конвейера.

## Влияние на производительность и память

- **VRAM.** `extra_slots × extra_max_context_len × sizeof(int32)` на строку индексов плюс, для SWA-моделей, `(window + page_size)` токенов KV на слот в оценке ёмкости. На длинном `--context-length` это перестает быть мелочью.
- **KV-пул.** Строки конкурируют за ту же память, что и токены: рост `extra_slots` уменьшает `max_total_num_tokens` при том же `--mem-fraction-static`.
- **Throughput.** Растет ровно в той мере, в какой прием KV перекрывается с генерацией. Если сеть быстрая и очередь передачи пустая, эффекта нет.
- **Latency.** На ITL не влияет; на TTFT влияет положительно, когда без слотов запрос ждал бы освобождения строки.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--disaggregation-mode decode`: единственный режим, где значение читается.
- `--max-running-requests` и `--dp-size`: входят в формулу авто-значения; порог — 32 запроса на воркер.
- `--context-length`: определяет длину строки индексов, то есть цену одного слота.
- `--num-reserved-decode-tokens`: другая ось того же дефицита — резерв токенов на активный запрос против числа строк под запросы в передаче.
- `--disaggregation-decode-polling-interval`: чем реже опрос, тем дольше запросы держат слоты.
- `--mem-fraction-static`: общий бюджет, из которого вычитается и пул строк, и KV.
- `--page-size` и SWA-окно: входят в оценку ёмкости SWA-пула для дополнительных слотов.

## Типовые проблемы и диагностика

- Прием KV не перекрывается с генерацией, decode работает «рывками»: скорее всего `--max-running-requests` большой и авто-значение равно `0`. Задайте число явно.
- После явного задания упал `max_total_num_tokens` (строка `KV Cache is allocated. ... size: ... GB` в логе старта) — это ожидаемая плата; уменьшайте значение или поднимайте `--mem-fraction-static`.
- Значение задано на prefill или на монолитном сервере и «ничего не делает» — так и должно быть, оно читается только в режиме `decode`.
- Проверить принятое значение: дамп `server_args=` при старте показывает уже подставленное авто-значение, поэтому по нему видно, что именно применилось.
- **В arriero:** relevant только внутри PD-развертывания, которое менеджер не супервизирует (один процесс на инстанс, `process/supervisor.ts`); для обычного инстанса задавать не нужно.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --max-running-requests 128 --disaggregation-decode-extra-slots 32
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --port 30001 --tensor-parallel-size 16 --dp-size 16 --enable-dp-attention --max-running-requests 256 --disaggregation-decode-extra-slots 8 --num-reserved-decode-tokens 256
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
