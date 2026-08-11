---
schema: 1
engine: sglang
primaryName: "--disaggregation-decode-polling-interval"
title: "--disaggregation-decode-polling-interval"
summary: Через сколько итераций цикла decode-сервера опрашивать очереди приема KV от prefill. `1` (по умолчанию) — каждую итерацию; значения больше единицы снижают накладные расходы опроса ценой задержки приема.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --disaggregation-decode-extra-slots
  - --num-reserved-decode-tokens
  - --max-running-requests
  - --disaggregation-decode-enable-offload-kvcache
---

# --disaggregation-decode-polling-interval

## Кратко

Аргумент относится только к серверу, запущенному с `--disaggregation-mode decode`. В его цикле планирования есть шаг `process_decode_queue`, который вытягивает предвыделенные запросы из очереди, опрашивает состояние KV-передач и переводит доехавшие запросы в общую очередь ожидания. Этот шаг стоит нескольких системных вызовов и (при TP > 1) all-reduce по группе, поэтому его можно выполнять не на каждой итерации. Значение `1` означает «каждую», `N` — «каждую N-ю».

## Оригинальная справка

```text
The interval to poll requests in decode server. Can be set to >1 to reduce the overhead of this.
```

## Паспорт аргумента

- Флаги: `--disaggregation-decode-polling-interval`
- Группа: `disagg`
- Тип значения: int
- Допустимые значения: `choices` нет. Практически осмысленны целые ≥ 1; проверки на положительность нет, и `0` приводит к делению по модулю на ноль
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным — ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.disaggregation_decode_polling_interval`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: читается один раз при первом вызове `process_decode_queue` в scheduler'е decode-сервера и кешируется в `self.polling_interval`; дальше действует на каждой итерации цикла планирования

## Что меняет в движке

`Scheduler.process_decode_queue` (`disaggregation/decode.py`) устроен так:

```python
if not hasattr(self, "polling_count"):
    self.polling_count = 0
    self.polling_interval = get_disagg().disaggregation_decode_polling_interval

self.polling_count = (self.polling_count + 1) % self.polling_interval

if self.polling_count % self.polling_interval == 0:
    req_conns, _ = self.disagg_decode_prealloc_queue.pop_preallocated()
    self.disagg_decode_transfer_queue.extend(req_conns)
    transferred_reqs = self.disagg_decode_transfer_queue.pop_transferred()
    self.waiting_queue.extend(transferred_reqs)
```

Под интервал попадают именно две тяжелые операции: `pop_preallocated` (подбор новых запросов, оценка бюджета KV-пула, предвыделение слотов, эвикция radix-кеша при необходимости) и `pop_transferred` (опрос состояния передач и, при TP > 1, all-reduce результатов опроса по attn-TP-группе).

Что **не** попадает под интервал и выполняется каждую итерацию:

- проверка событий HiCache при `--disaggregation-decode-enable-radix-cache` в связке с иерархическим кешем;
- `check_offload_progress()` при `--disaggregation-decode-enable-offload-kvcache`;
- `resume_retracted_reqs()` — попытка вернуть вытесненные запросы. Больше того: если очередь вытесненных не пуста, функция выходит **до** блока с интервалом, и новые запросы не принимаются вовсе, каким бы ни было значение.

## Значения и формат

- `1` — опрос каждую итерацию. Это значение по умолчанию и нормальный выбор для подавляющего большинства конфигураций.
- `N > 1` — опрос каждую N-ю итерацию. Прием запросов и приход KV замечаются с задержкой до `N-1` шагов decode.
- `0` — не отвергается argparse, но при первом же вызове дает `ZeroDivisionError: integer division or modulo by zero` на `(self.polling_count + 1) % self.polling_interval`. Не используйте.
- Отрицательные значения формально проходят, но семантика периода для них не определена разработчиком; считайте их некорректным вводом.
- Изменение на живом сервере невозможно: значение кешируется в `self.polling_interval` при первом вызове.

## Когда использовать

- Decode-сервер с большим `--tp-size`, где профиль показывает заметную долю времени в опросе/all-reduce очередей приема, а батч и так все время полон. Тогда `2`–`4` снимают накладные расходы почти без вреда для TTFT.
- Очень короткие decode-шаги (маленькая модель, маленький батч), когда итерация дешевле, чем ее обслуживание.
- Не поднимайте на нагрузке, чувствительной к TTFT: каждая пропущенная итерация — это задержка перед тем, как доехавший KV превратится в генерацию.
- Не используйте как средство «починить» нехватку памяти или переполнение очереди — на это влияют `--max-running-requests`, `--num-reserved-decode-tokens` и `--disaggregation-decode-extra-slots`.

## Влияние на производительность и память

- **CPU планировщика.** Основной эффект: реже вызывается `pop_preallocated`/`pop_transferred` со всей их арифметикой бюджета и коллективом по TP-группе.
- **TTFT.** Растет примерно на `(N-1)/2` decode-шагов в среднем и до `N-1` в худшем случае — для каждого запроса дважды (вход в предвыделение и признание передачи завершенной).
- **VRAM.** Прямого влияния нет. Косвенное: при больших `N` запросы дольше держатся в очереди передачи, а значит дольше занимают предвыделенные слоты и зарезервированные токены.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--disaggregation-mode decode`: вне этого режима значение не читается вообще.
- `--disaggregation-decode-extra-slots`: чем реже опрос, тем дольше живут «запросы в передаче», под которые эти слоты и резервируются.
- `--num-reserved-decode-tokens`: резерв держится на каждый активный запрос, включая находящиеся в очередях предвыделения и передачи.
- `--max-running-requests`: определяет, сколько запросов вообще может стоять в этих очередях.
- `--disaggregation-decode-enable-offload-kvcache` и `--disaggregation-decode-enable-radix-cache`: их обслуживание из-под интервала выведено и идет каждую итерацию.
- `--tp-size`: при TP > 1 опрос сопровождается all-reduce, из-за чего экономия от `N > 1` заметнее.

## Типовые проблемы и диагностика

- `ZeroDivisionError: integer division or modulo by zero` в scheduler'е decode сразу после первого запроса — задан `0`.
- Выросло TTFT после подъема значения — ожидаемый эффект, а не баг. Вернитесь к `1` и ищите накладные расходы профилировщиком.
- Значение подняли, а нагрузка на CPU не изменилась: скорее всего сервер большую часть времени проводит в `resume_retracted_reqs`, потому что очередь вытесненных не пуста. Смотрите на вытеснения и на `--max-running-requests`, интервал здесь ни при чем.
- Принятое значение — в дампе `server_args=` при старте.
- **В arriero:** decode-сервер — часть PD-развертывания, которое менеджер не супервизирует (один процесс на инстанс, `process/supervisor.ts`), поэтому в конфигурации инстанса этот аргумент смысла не имеет.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --disaggregation-decode-polling-interval 2
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --port 30001 --tensor-parallel-size 16 --dp-size 16 --enable-dp-attention --disaggregation-decode-polling-interval 4 --max-running-requests 256
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
