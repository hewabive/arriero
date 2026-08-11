---
schema: 1
engine: sglang
primaryName: "--pp-async-batch-depth"
title: "--pp-async-batch-depth"
summary: Добавляет слоты микробатчей сверх числа PP-стадий и переносит отправку выходов предыдущего микробатча до запуска текущего. Уменьшает пузыри конвейера ценой памяти под лишние слоты.
group: parallel
related:
  - --pp-size
  - --pp-max-micro-batch-size
  - --max-running-requests
  - --disable-overlap-schedule
  - --chunked-prefill-size
---

# --pp-async-batch-depth

## Кратко

Цикл pipeline parallelism держит кольцо слотов микробатчей длиной `pp_loop_size = pp_size + pp_async_batch_depth`. При значении `0` кольцо ровно по числу стадий, и отправка выходов предыдущего микробатча выполняется **после** запуска текущего. При положительном значении слотов больше, а отправка и подготовка выходов переносятся **до** запуска — то есть коммуникация уходит под вычисление. Аргумент имеет смысл только при `--pp-size > 1`; на одностадийном сервере он лишь увеличит число неиспользуемых слотов.

## Оригинальная справка

```text
The async batch depth of pipeline parallelism.
```

## Паспорт аргумента

- Флаги: `--pp-async-batch-depth`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет, границы не проверяются нигде — ни на старте, ни в runtime
- Значение по умолчанию: `0`
- Эффективное значение: совпадает с заданным; автоподбора нет
- Где объявлен: `ServerArgs.pp_async_batch_depth`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: `init_pp_loop_state` в `Scheduler` (размер кольца слотов) → каждый проход цикла событий PP
- Статус: обычный

## Что меняет в движке

`init_pp_loop_state` (`sglang/python/sglang/srt/managers/scheduler_pp_mixin.py`):

```python
self.pp_loop_size: int = self.ps.pp_size + get_parallel().pp_async_batch_depth
self.mbs = [None] * self.pp_loop_size
self.last_mbs = [None] * self.pp_loop_size
self.running_mbs = [ScheduleBatch(reqs=[], batch_is_full=False) for _ in range(self.pp_loop_size)]
self.mb_metadata = [None] * self.pp_loop_size
```

Кольцо слотов используется циклически (`next_mb_id = (mb_id + 1) % self.pp_loop_size`), и его длина определяет, сколько микробатчей одновременно находятся «в полете» на этом ранге.

Второе действие — перестановка шага в цикле. Во всех трех вариантах PP-цикла (обычный, prefill-ветка дезагрегации и decode-ветка) встречается одна и та же пара:

```python
if get_parallel().pp_async_batch_depth > 0:
    next_pp_outputs, next_batch_result, d2h_event = self._pp_commit_send_output_work_and_preprocess_output_tensors(...)
self._pp_commit_comm_work(self.send_proxy_work)
if cur_batch:
    result, self.launch_event = self._pp_launch_batch(...)
if get_parallel().pp_async_batch_depth == 0:
    next_pp_outputs, next_batch_result, d2h_event = self._pp_commit_send_output_work_and_preprocess_output_tensors(...)
```

Комментарий в коде называет это «early send output if possible»: при положительной глубине завершение и отправка выходов предыдущего микробатча происходят перед запуском текущего, чтобы копирование device→host и межстадийная передача перекрылись с вычислением.

## Значения и формат

- Целое. `0` — обычный режим, кольцо длиной `pp_size`.
- Отрицательные значения argparse примет, а движок не проверит: `pp_loop_size` станет меньше `pp_size`, что нарушает логику конвейера. Не используйте.
- Разумный диапазон — небольшие положительные числа (1–2). Каждый слот — это отдельный `ScheduleBatch` и связанные с ним буферы.
- Верхней границы нет; чрезмерное значение просто отъест память и слоты запросов.
- Значение осмысленно только при `--pp-size > 1`.

## Когда использовать

- `--pp-size > 1` и заметные пузыри конвейера: стадии простаивают, пока идет передача выходов. Начните с `1` и измерьте.
- Медленный межстадийный канал (PCIe вместо NVLink, разные узлы): перенос отправки под вычисление окупается заметнее.
- Не включать без pipeline parallelism.
- Не поднимать выше 1–2 без измерений: рост числа одновременно живых микробатчей увеличивает и занятость KV-пула, и число запросов, «зависших» в конвейере.

## Влияние на производительность и память

- Throughput при `--pp-size > 1`: цель аргумента — заполнить пузыри конвейера перекрытием коммуникации и вычисления.
- VRAM: растет. Каждый дополнительный слот — это еще один микробатч, чьи запросы удерживают KV-страницы и слоты `req_to_token`, пока не завершатся.
- Latency отдельного запроса: может слегка вырасти — запрос дольше ждет своей очереди в более длинном кольце.
- Без PP влияния нет, кроме бесполезно выделенных структур под лишние слоты.

## Взаимодействие с другими аргументами

- `--pp-size`: база кольца; сумма и есть `pp_loop_size`.
- `--pp-max-micro-batch-size`: ограничивает размер каждого микробатча; произведение с числом слотов определяет пиковую занятость планировщика.
- `--max-running-requests`: общий потолок; из него же выводится умолчание `--pp-max-micro-batch-size` (`max_running_requests // pp_size`).
- `--disable-overlap-schedule`: при `--pp-size > 1` включается принудительно (`Pipeline parallelism is incompatible with overlap schedule.`), поэтому перекрытие внутри PP-цикла — единственный доступный механизм.
- `--chunked-prefill-size`: длительность одного микробатча prefill, то есть насколько велика «тень», под которую прячется коммуникация.

## Типовые проблемы и диагностика

- Значение задано, эффекта нет — проверьте `pp_size` в дампе `server_args=`: без PP аргумент бездействует.
- Рост занятости KV-пула и учащение `KV cache pool is full. Retract requests.` после включения — прямое следствие числа одновременно живых микробатчей. Уменьшите глубину либо `--pp-max-micro-batch-size`.
- Странное поведение при отрицательном значении — не диагностируется движком; проверьте, что значение положительное.
- Что смотреть: `pp_async_batch_depth=` и `pp_size=` в дампе `server_args=`; занятость пула — в строках `Decode batch, … token usage: …`; профиль (`torch.profiler.record_function` расставлены в PP-цикле по именам `recv_requests`, `send_reqs_to_next_stage`, `get_next_batch_to_run`, `process_batch_result`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --pipeline-parallel-size 2 --disable-overlap-schedule --pp-async-batch-depth 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --pipeline-parallel-size 4 --disable-overlap-schedule --pp-async-batch-depth 2 --pp-max-micro-batch-size 8 --watchdog-timeout 3600
```

## Источники

- `sglang/python/sglang/srt/managers/scheduler_pp_mixin.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
