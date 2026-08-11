---
schema: 1
engine: sglang
primaryName: "--optimistic-prefill-attempts"
title: "--optimistic-prefill-attempts"
summary: Разрешает prefill-серверу начать считать промпт, не дождавшись рукопожатия с decode. Число — это лимит попыток на запрос; `0` (по умолчанию) выключает оптимистичный путь.
group: disagg
related:
  - --disaggregation-mode
  - --pp-size
  - --enable-hierarchical-cache
  - --hicache-storage-backend
  - --hicache-write-policy
  - --mamba-radix-cache-strategy
  - --chunked-prefill-size
  - --max-running-requests
  - --enable-metrics
---

# --optimistic-prefill-attempts

## Кратко

В обычном PD-потоке prefill-сервер сначала ждет, пока decode пришлет свои KV-индексы (состояние `Bootstrapping`), и только потом ставит запрос в очередь на счет. Это ожидание — чистое время в TTFT, за которое GPU простаивает. Оптимистичный prefill разрешает не ждать: запрос идет в forward сразу, а рукопожатие проверяется по ходу дела. Если оно так и не завершилось к концу счета, посчитанный KV кладется в radix-кеш, запрос откатывается и ставится обратно в очередь — и так до исчерпания лимита попыток. Аргумент читается только на `--disaggregation-mode prefill` и тихо обнуляется при нескольких несовместимых конфигурациях.

## Оригинальная справка

```text
Number of optimistic prefill forward passes that skip the bootstrap wait.
```

## Паспорт аргумента

- Флаги: `--optimistic-prefill-attempts`
- Группа: `disagg`
- Тип значения: int
- Допустимые значения: `choices` нет; осмысленны целые ≥ 0
- Значение по умолчанию: `0` (оптимистичный путь выключен)
- Эффективное значение: при `> 0` и `--disaggregation-mode prefill` `_handle_other_validations` сбрасывает его обратно в `0` с предупреждением в трех случаях: `--pp-size > 1`; `--enable-hierarchical-cache` с непустым `--hicache-storage-backend` **или** `--hicache-write-policy`, отличным от `write_back`; модель использует mamba-radix-кеш. Вне режима `prefill` значение не читается вообще
- Где объявлен: `ServerArgs.optimistic_prefill_attempts`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_other_validations` (обнуление при несовместимости) → `PrefillBootstrapQueue.pop_bootstrapped` при каждом опросе очереди → `optimistic_release_and_requeue` при откате

## Что меняет в движке

### Пропуск ожидания

`PrefillBootstrapQueue.pop_bootstrapped` (`disaggregation/prefill.py`) при `poll == KVPoll.Bootstrapping` обычно просто оставляет запрос в очереди. При `req.prefill_attempt_count < optimistic_prefill_attempts` и незаретрактованном запросе он вместо этого:

- захватывает metadata-буфер (`ensure_metadata_buffer`; если буферов нет — остается в очереди);
- увеличивает `prefill_attempt_count`;
- помечает запрос как `pending_bootstrap` и отправляет в общую очередь ожидания на счет.

Дальше `check_bootstrap` опрашивает рукопожатие на каждом шаге. Как только оно приходит (`KVPoll.WaitingForInput`), `finalize_bootstrap` доводит sender до готовности и передача KV идет обычным путем.

### Откат

Если рукопожатие не пришло, а посчитать больше нечего (или подошли запросы с уже завершенным bootstrap'ом), вызывается `optimistic_release_and_requeue`:

- посчитанный KV сохраняется в дерево префиксов (`maybe_cache_unfinished_req`), а слоты освобождаются;
- состояние отправки сбрасывается: `start_send_idx = 0`, `disagg_decode_prefix_len = 0`, очищаются `hidden_states_tensor` и накопленные чанки — при следующей попытке всё пойдет с нуля;
- если `prefill_attempt_count >= optimistic_prefill_attempts`, запрос возвращается в bootstrap-очередь с сообщением `Req <rid> exhausted optimistic prefill attempts falling back to bootstrap queue`;
- иначе счетчик увеличивается, в лог идет `Req <rid> optimistic prefill yielded (<n>/<max> attempts used)`, запрос ставится **в начало** очереди ожидания, и при `--enable-metrics` инкрементируется счетчик `prefill_retries`.

Ключевая экономия здесь не в самом форварде, а в том, что результат откатанного прохода не выбрасывается: он лежит в radix-кеше, и повторный проход обычно попадает в него почти целиком.

## Значения и формат

- Целое число попыток. `0` — путь выключен, поведение классическое.
- `1` — одна оптимистичная попытка на запрос, затем возврат к обычному ожиданию. Разумная стартовая величина.
- Больше 1 осмысленно только когда рукопожатие регулярно задерживается на время, сравнимое с временем счета промпта.
- Верхней границы нет; каждая попытка стоит одного полного прохода prefill и одного metadata-буфера.
- Отрицательные значения формально проходят argparse, но условие `prefill_attempt_count < optimistic_prefill_attempts` при них никогда не выполнится — эффект тот же, что у `0`.

## Когда использовать

- Медленное или нестабильное рукопожатие с decode: decode перегружен, сеть управляющего канала загружена, decode-нод много и они по очереди отвечают. Симптом — заметная доля TTFT приходится на состояние `Bootstrapping`.
- Длинные промпты, где один проход prefill заведомо дольше рукопожатия: тогда оптимистичный проход почти всегда успевает «поймать» bootstrap по дороге.
- Не включайте при быстром рукопожатии: вы получите откаты и лишние проходы там, где ожидание стоило миллисекунды.
- Не включайте при `--pp-size > 1`, с L2-HiCache вне `write_back` и на mamba-моделях: значение все равно обнулится, но в логе останется предупреждение.
- Не включайте, если metadata-буферов и так впритык: оптимистичные запросы занимают их раньше срока.

## Влияние на производительность и память

- **VRAM.** Оптимистичный запрос занимает KV-слоты и metadata-буфер до того, как рукопожатие подтвердило, что он вообще поедет. При откате слоты освобождаются, но посчитанный префикс остается в radix-дереве и продолжает занимать память до вытеснения.
- **Compute.** Худший случай — `optimistic_prefill_attempts` лишних проходов на запрос. Практически он мягче: повторный проход в основном попадает в radix-кеш, оставленный предыдущей попыткой.
- **TTFT.** Падает при удаче (счет и рукопожатие идут параллельно), растет при систематических откатах.
- **Пропускная способность.** На насыщенном prefill-сервере оптимистичные проходы конкурируют с обычными за очередь; при `has_bootstrapped_waiting_req()` оптимистичный запрос уступает место готовым — это встроенная защита, но она означает откат.
- **Хост.** Не влияет.

## Взаимодействие с другими аргументами

- `--disaggregation-mode prefill`: единственный режим, где значение читается.
- `--pp-size > 1`: обнуляет значение (`Optimistic prefill does not support pp_size > 1`).
- `--enable-hierarchical-cache` + `--hicache-storage-backend` или `--hicache-write-policy != write_back`: обнуляет значение (`Optimistic prefill only supports L2 hierarchical cache with write-back policy`). Обратите внимание, что умолчание политики — `write_through`, поэтому связка «иерархический кеш + оптимистичный prefill» без явного `--hicache-write-policy write_back` не заработает.
- `--mamba-radix-cache-strategy` / mamba-модели: обнуляет значение.
- `--disable-radix-cache`: не запрещен формально, но лишает механизм смысла — откатанный проход тогда не сохраняется и повтор считает всё заново.
- `--chunked-prefill-size`: оптимистичный запрос может быть чанкованным; откат сбрасывает прогресс чанков целиком.
- `--max-running-requests`: определяет размер пула metadata-буферов (`max_running_requests * 2` на prefill), который оптимистичные запросы занимают раньше срока.
- `--enable-metrics`: включает счетчик `prefill_retries`, по которому и видно, окупается ли механизм.

## Типовые проблемы и диагностика

- `Optimistic prefill does not support pp_size > 1` / `Optimistic prefill only supports L2 hierarchical cache with write-back policy` / `Optimistic prefill does not support models that use mamba radix cache.` — значение обнулено на старте; уберите флаг или устраните конфликт.
- Много строк `Req <rid> optimistic prefill yielded (n/N attempts used)` — механизм работает вхолостую: рукопожатие медленнее, чем весь prefill. Уменьшайте число попыток или разбирайтесь с decode-стороной.
- `Req <rid> exhausted optimistic prefill attempts falling back to bootstrap queue` — лимит исчерпан, запрос вернулся к обычному ожиданию. Единичные строки нормальны, массовые означают, что механизм не подходит нагрузке.
- Растет доля отказов metadata-буферов (запросы «залипают» в bootstrap-очереди) — оптимистичные запросы держат буферы; поднимайте `--max-running-requests` или снижайте число попыток.
- Метрика `prefill_retries` при `--enable-metrics` — прямая мера цены механизма.
- Принятое (уже обнуленное, если конфликт) значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode prefill --port 30000 --optimistic-prefill-attempts 1
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode prefill --port 30000 --tensor-parallel-size 16 --dp-size 8 --enable-dp-attention --optimistic-prefill-attempts 2 --max-running-requests 64 --enable-metrics
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/prefill.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
