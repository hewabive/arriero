---
schema: 1
engine: sglang
primaryName: "--min-free-slots-delay"
title: "--min-free-slots-delay"
summary: Откладывает новые prefill'ы, пока не освободится хотя бы N слотов running-батча, чтобы принять их одним батчем. Явное N имеет приоритет и обрезается только по `--max-running-requests`; старая DFlash-формула применяется только к незаданному флагу.
group: schedule
related:
  - --max-running-requests
  - --speculative-algorithm
  - --pp-max-micro-batch-size
  - --enable-prefill-delayer
  - --chunked-prefill-size
---

# --min-free-slots-delay

## Кратко

Когда каждый допуск запроса стоит дорого сам по себе (например, при спекулятивном декодировании с отдельным draft-prefill'ом), выгоднее дождаться, пока освободится несколько слотов, и запустить prefill один раз на всю группу. `--min-free-slots-delay` задает это число слотов. Механизм локален для ранга и полностью независим от prefill-delayer'а (`--enable-prefill-delayer`), хотя решает похожую задачу.

## Оригинальная справка

```text
Hold new prefills until at least N running-request slots have freed up, so they are admitted in one batch instead of one at a time. Useful when each admission is disproportionately expensive, e.g. speculative decoding with a separate draft prefill pass. An explicit value always wins, capped by max-running-requests (1 disables). When unset, DFlash workloads auto-enable the formula; other workloads stay disabled. Not supported with pipeline parallelism.
```

## Паспорт аргумента

- Флаги: `--min-free-slots-delay`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: не ограничены на уровне argparse; значение `<= 1` означает «выключено», иначе явный порог приводится к `min(значение, max_running_requests)`
- Значение по умолчанию: `null` — «выключено, кроме DFlash-семейства»
- Эффективное значение: считается в `resolve_min_free_slots` (`sglang/python/sglang/srt/managers/min_free_slots_delayer.py`). Если аргумент задан, используется `min(user_value, max_running_requests)` без DFlash-формулы. Если не задан и выбрано DFlash-семейство (`DFLASH`, `DSPARK`), порог равен `min(4, max(2, (max_running_requests + 5) // 6))` при `max_running_requests >= 8`; для остальных нагрузок механизм выключен
- Где объявлен: `ServerArgs.min_free_slots_delay`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация планировщика (создание `MinFreeSlotsDelayer`) → начало каждой сборки prefill-батча

## Что меняет в движке

Проверка стоит в самом начале `Scheduler._get_new_batch_prefill_raw` (`sglang/python/sglang/srt/managers/scheduler.py`), до сортировки очереди и до создания `PrefillAdder`:

```python
if (self.min_free_slots_delayer is not None
        and self.chunked_req is None
        and self.min_free_slots_delayer.should_delay(
            running_bs=running_bs,
            num_allocatable_reqs=self.get_num_allocatable_reqs(running_bs))):
    return None, running_batch
```

`should_delay` истинна, когда `running_bs > 0` и `num_allocatable_reqs < min_free_slots`. Величина `num_allocatable_reqs` — это `min(pp_max_micro_batch_size - running_bs, req_to_token_pool.available_size())`, то есть число слотов, куда физически можно посадить новый запрос.

Три следствия, которые видно только из кода:

- на пустом сервере (`running_bs == 0`) задержки не бывает никогда — первый запрос стартует немедленно;
- продолжение chunked prefill (`self.chunked_req is not None`) проходит без задержки, иначе незавершенный запрос завис бы;
- решение принимается локально каждым рангом: слоты running-батча приватны для DP-ранга, и ранг со свободными слотами не ждет перегруженного соседа.

## Значения и формат

- Целое число слотов running-батча.
- Явное значение обрезается только по `max_running_requests`; оно может быть больше 4 и не зависит от DFlash-формулы.
- `1` и `0` (а также отрицательные) отключают механизм: до обрезки проверяется `user_value <= 1`.
- При `max_running_requests < 8` автовыбор DFlash выключен, но явный порог 2…`max_running_requests` все равно работает.
- Явное значение полностью заменяет DFlash-формулу: оно может как опустить порог до `1` и выключить механизм, так и поднять его выше 4, но не выше `max_running_requests`.
- Типичный авторезультат DFlash-формулы — от 2 до 4 слотов: 2 при `max_running_requests` 8–12, 4 начиная с 19.
- При `--pp-size > 1` явное значение запрещено предстартовым assert: свободные слоты microbatch ограничены `--pp-max-micro-batch-size`, и порог может никогда не достичься.

## Когда использовать

- Спекулятивное декодирование с отдельным draft-prefill'ом (DFlash/DSpark) — штатный случай, включается сам; вручную имеет смысл трогать только при нестандартном `max_running_requests`.
- Нагрузка, где в логе видно череду `Prefill batch, #new-seq: 1` при полном running-батче и непустой очереди: каждый освободившийся слот тут же тратится на отдельный prefill-проход.
- Не включайте на интерактивной нагрузке с низкой конкурентностью: большой явный порог может держать новый запрос без таймаута до освобождения N слотов.
- Не используйте с pipeline parallelism: явное значение не дойдет до планировщика.

## Влияние на производительность и память

- На память не влияет: задержка происходит до расчета бюджетов KV.
- Throughput растет там, где фиксированная цена prefill-прохода велика относительно объема работы (draft-prefill спекуляции, крупные графы).
- TTFT растет: запрос ждет освобождения N слотов. Верхнего предела по времени у механизма нет — в отличие от prefill-delayer'а, здесь нет ни потолка в проходах, ни лимита в миллисекундах. Ограничитель один: как только слоты освободятся, prefill пойдет.
- На время старта и VRAM влияния нет.

## Взаимодействие с другими аргументами

- `--max-running-requests`: верхняя граница явного порога и вход в DFlash-формулу при автовыборе.
- `--speculative-algorithm`: только DFlash-семейство включает механизм автоматически.
- `--pp-max-micro-batch-size`: участвует в расчете `num_allocatable_reqs` даже при `pp_size == 1`.
- `--enable-prefill-delayer`: независимый механизм с той же целью. Оба могут быть включены одновременно; их задержки складываются.
- `--chunked-prefill-size`: продолжение начатого chunked prefill эту задержку не проходит.

## Типовые проблемы и диагностика

- Значение задано, но эффекта нет: проверьте, что оно больше 1; `0`, `1` и отрицательные числа явно отключают delayer.
- Порог меньше заданного: явное значение обрезано по `--max-running-requests`, а не по DFlash-формуле.
- `--min-free-slots-delay is not supported with pipeline parallelism` — уберите флаг или верните `--pp-size 1`.
- Ощутимо вырос TTFT на слабой нагрузке: механизм не имеет таймаута, при редких запросах он держит prefill до освобождения слотов; уменьшите порог или отключите значением `1`.
- Отдельной метрики у механизма нет. Косвенный признак работы — рост `#new-seq` и падение частоты строк `Prefill batch` при неизменном `#queue-req`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-running-requests 64 --min-free-slots-delay 4
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-running-requests 32 --min-free-slots-delay 1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/min_free_slots_delayer.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/speculative/spec_info.py`
